#!/usr/bin/env node
// GET THE FLEET ARMED, ARMOURED AND TAUGHT, and pay for it out of the bank.
//
//   node tools/m59-outfit.mjs                      # everyone who is short of gear
//   node tools/m59-outfit.mjs --learn block        # everyone who does not know it
//   node tools/m59-outfit.mjs --learn block --gear # and top up their gear while there
//   node tools/m59-outfit.mjs --agents t1,t2       # just these
//   node tools/m59-outfit.mjs --at 201             # shop here rather than the nearest
//   node tools/m59-outfit.mjs --withdraw 1000      # how much to take out per character
//   node tools/m59-outfit.mjs --dry-run            # say what it would buy and stop
//
// WHY THIS EXISTS AS A TRIP RATHER THAN A KEEPER RULE. Buying is several minutes of
// walking, a shop, and a bank, and the keeper's pass is eight seconds long — so this
// stops the keeper, does the errand, and puts the orders back exactly as they were.
// Anything that drives a character has to be serialised against everything else that
// drives one, or two loops walk the same character to two different towns.
//
// BUYING ORDER IS DEFENCE FIRST. A weapon changes how fast something dies; armour
// changes whether you are still standing when it does. See m59-skills.mjs ARMOUR for
// why leather outranks plate here rather than being the cheap option.
//
// A SKILL IS BOUGHT THE SAME WAY A HAT IS. `AssembleForSaleList` (monster.kod:4819)
// puts skills and spells in the same offer list as the stock, and `Buy` calls AddSkill
// instead of handing over an object (monster.kod:3862). So the errand is the same trip
// with a different shopping list, and this file grew `--learn` rather than a sibling.
//
// THREE THINGS ABOUT LEARNING THAT GEAR-BUYING NEVER HAD TO KNOW:
//
//   * IT REFUSES BY SAYING NOTHING. The offer list is filtered per BUYER — a skill you
//     already have, or cannot yet learn, is simply ABSENT (monster.kod:4855-4861) with
//     no message of any kind. A quiet buy is therefore not evidence of anything, so
//     every purchase here is checked afterwards against `abilities`, which is the same
//     shape as `stats_as_asked` and `describe --verify`: the record is the claim, the
//     re-read is the evidence.
//   * THE PRICE IS KNOWN BEFORE THE TRIP. It is `250 * 2^level` and carries NO markup
//     (monster.kod:4880), so unlike a hat it cannot cost more when you get there. That
//     is what lets the errand withdraw the right amount — and it must, because a level
//     1 skill is 500 and nobody in this fleet walks around with 500 in a pocket.
//   * MOST TEACHERS ARE NOT NEXT TO A BANK. Jonas D'Accor sells block in Pietro's
//     Wicked Brews and the Royal Bank of Jasper is five rooms away, which is close —
//     the Cor Noth sergeant, who sells ten skills, is not close to anything. So a
//     character short of the price goes via a banker for its OWN account first.
//
// EACH TOWN KEEPS A SEPARATE BANK ACCOUNT (holder.kod:828 relays the request to
// whatever is in the room). Money paid in at Tos is not available in Marion. So the
// withdrawal is attempted where the character already is, and a character whose money
// is in another town is reported rather than silently left broke — with `--from-mate`
// a partner standing there can cover it instead.
import { loadMerchants } from './m59-merchants.mjs';
import { BANKERS, accountOf } from './m59-bank.mjs';
import { loadoutFor } from './m59-loadout.mjs';
import { armourKind, armourScore } from './m59-skills.mjs';
import { armOwnership, brokerDriver } from './m59-atomics.mjs';

const arg = (name, def = null) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const URL = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const AT = arg('at', null) == null ? null : Number(arg('at'));
const WITHDRAW = Number(arg('withdraw', 1000));
// HOW MANY OF THE WORKING WEAPON TO CARRY AWAY. A weapon in use shatters, and a shattered
// one is unequipped, left in the pack under its own name (weapon.kod:788 changes only the
// icon), refused silently by the next wield, and dropped by the keeper's 120s sweep. So the
// character needs DEPTH here, not a spare: one replacement per trip loses the race against
// a fleet that re-armed four times in an afternoon and was back on looted long swords each
// time. Three is a few hours of farming rather than one.
const WEAPON_SPARES = Number(arg('weapon-spares', 3));
// And what sell_all may keep, which must LEAVE ROOM FOR THOSE — selling runs first, so a
// keep limit below the spare depth would sell a mace at the start of every trip and buy it
// back at the end, paying the vendor spread for the privilege. One above the depth, for
// whatever is currently wielded. `sell_all` defaults this to null, and null means "no
// weapon limit configured", which keeps every long sword in the pack — so it is always
// passed explicitly rather than left to the default.
const WEAPONS_TO_KEEP = Number(arg('keep-weapons', WEAPON_SPARES + 1));
// Planned-learning buttons know the exact fixed ability price before leaving. In that
// mode, carry the bill rather than the outfitter's ordinary 200-shilling contingency;
// the character is going to one teacher for one purchase, not shopping speculatively.
const EXACT_FUNDING = !!arg('exact-funding', false);
const ONLY = arg('agents', null);
const FROM_MATE = !!arg('from-mate', false);
// What to learn, by the name the GAME uses — "mace fighting", not "proficiency mace".
// m59-merchants.mjs takes those names from each ability's own class for exactly this
// reason; a name nothing answers to is indistinguishable from a skill nobody sells.
const LEARN = (arg('learn', null) === true || arg('learn', null) == null)
  ? [] : String(arg('learn')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// Gear is the default errand and stays the default. Asking to learn something makes the
// trip about the teacher, because the teacher and the smith are rarely in one room and
// a trip that tries to be both ends up doing neither.
const WANT_GEAR = !LEARN.length || !!arg('gear', false);

let id = 0;
async function call(name, args = {}, timeoutMs = 30_000) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// WHO THIS ERRAND IS, for the ownership lease. `outfit/<pid>` -- the pid makes every
// run a distinct owner, so a second run (keeper-spawned, GOAP, or a hand-run one) is
// refused the claim it cannot have and backs off instead of double-driving the same
// character. The lease fails back to the keeper when this process dies.
const OWNER = `outfit/${process.pid}`;

// WHAT A CHARACTER GOING TO THE VALLEY NEEDS, WHEN NOBODY HAS SAID OTHERWISE. One line
// each so the list is the argument: a mace because these characters' proficiency is in
// mace fighting, leather because it is the only armour with positive defence and no spell
// penalty, a shield because it is the cheapest defence in the game at 160.
//
// This is the FLEET default and it is one answer for twenty-one characters. A character
// with a loadout gets its own list instead — see wantsFor below.
const WANTS = [
  { slot: 'armour', re: /leather (armor|armour)/i,  fallback: /armor|armour|mail/i, what: 'leather armour' },
  { slot: 'shield', re: /metal shield/i,            fallback: /shield/i,            what: 'a shield' },
  { slot: 'weapon', re: /\bmace\b/i,                fallback: /sword|axe|hammer|mace/i, what: 'a mace' },
];

const nameOf = (i) => String(i?.name ?? i ?? '');
const carries = (items, re) => items.some(i => re.test(nameOf(i)));
const purseOf = (items) => items.filter(i => /shilling/i.test(nameOf(i)))
                                .reduce((t, i) => t + (i.amount || 1), 0);

// THIS CHARACTER'S OWN GEAR LIST, TURNED INTO THE SAME SHAPE THE SHOP LOOP ALREADY READS.
//
// A NAMED WANT IS SATISFIED BY THE NAME; A GENERIC ONE IS SATISFIED BY THE FAMILY. That
// difference is the whole value of a loadout and it is easy to lose. The fleet default
// says "a mace" and means "some weapon" — its fallback is `/sword|axe|hammer|mace/`,
// because one answer for twenty-one characters cannot be fussier than that. A loadout
// says "short sword", and a character holding a mace IS missing it: getting back to the
// named weapon after a day of breaking things is the thing the list exists for.
//
// The first version widened the loadout's fallback to the slot's family, and the effect
// was to make every loadout mean exactly what the fleet default meant: Kermit, whose list
// says short sword and whose pack holds a mace, reported "already stocked".
//
// So the fallback here is the OTHER LISTED CHOICES and nothing else. A preference order is
// still a preference — a character holding its second choice is not missing its gear, and
// buying it a third is how an errand wastes a trip.
//
// Escaped, because an item name is data and `\bmace\b` is not: unescaped, "wizard's staff
// (+1)" is a regex with a group and a quantifier in it, and would match nothing while
// looking like it should.
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

export function wantsFor(loadout) {
  if (!loadout) return WANTS;
  const out = [];
  const add = (slot, list) => {
    if (!list || !list.length) return;
    out.push({ slot, re: rx(list[0]),
               fallback: new RegExp(list.map(n => rx(n).source).join('|'), 'i'),
               what: list[0] });
  };
  add('weapon', loadout.gear.weapon);
  for (const [slot, list] of Object.entries(loadout.gear.slots)) add(slot, list);
  // A loadout that says nothing about gear is not a loadout that wants none — it simply
  // has no opinion, and the fleet default is the standing one.
  return out.length ? out : WANTS;
}

// What is this character missing? Read the PACK for what it owns; wearing is a
// separate question and wear_best answers it afterwards.
// A BROKEN PIECE IS NOT STOCK, AND IT IS SPELLED EXACTLY LIKE STOCK.
//
// "This leather armor is useless. It has been torn into several pieces" — and it is still
// called "leather armor" on every list. So a name-based stock check counts it, reports
// `already stocked`, and the character goes back out bare: wear_best condemns it into the
// keeper's broken set and then truthfully answers "nothing of this kind in the pack",
// which is a sentence about a pack that visibly contains one. Gonzo ran that way with
// 3,022 shillings and a broken armour and shield, and every report said armour: owned.
//
// The `inventory` tool now carries the keeper's own verdict on each row, so this asks the
// one thing that knows rather than re-deriving it from the description.
// AND ARMOUR THE WEARER WILL REFUSE IS NOT STOCK EITHER, FOR THE SAME REASON A BROKEN
// PIECE IS NOT.
//
// Both halves of this had to be fixed or the tool contradicts itself: the buy path now
// declines chain and plate (they score below bare skin, see the note at the shop loop),
// but `missingFor` still counted the chain armor Floyd was already carrying as a filled
// armour slot — so he reported "already stocked" at a smith that had leather on the shelf,
// twice, while walking around in a shield and nothing else.
//
// "Stocked" has to mean the same thing here as it does to wear_best, or the character is
// told it owns armour by one half of the tool and refused it by the other.
const usable = (items) => (items || []).filter(i => {
  if (i.broken) return false;
  const k = armourKind(nameOf(i));
  return !k || armourScore(k) > 0;
});

// Would this character actually put it on? Shared by the shop-choosing loop and the buy
// loop, so "this smith supplies what we need" and "buy this" cannot disagree — chain and
// plate score below bare skin and are neither.
const wearableItem = (i) => {
  const k = armourKind(nameOf(i));
  return !k || armourScore(k) > 0;
};
function missingFor(items, wants = WANTS) {
  const have = usable(items);
  return wants.filter(w => !carries(have, w.re) && !carries(have, w.fallback));
}

// --------------------------------------------------------------- what to learn

const CATALOGUE = (() => { try { return loadMerchants(); } catch { return null; } })();

// WHAT IT IS CALLED AND WHAT IT COSTS, asked of the catalogue rather than assumed here.
// The name has to be the game's own — "mace fighting", not "proficiency mace" — and the
// catalogue takes those from each ability's own class for exactly that reason.
//
// An ambiguous name is REPORTED, not resolved. "resist" matches three spells at three
// different prices, and quietly buying the cheapest is the kind of helpfulness that is
// indistinguishable from a bug for about a week.
export function abilityWanted(want, catalogue = CATALOGUE) {
  const q = String(want).toLowerCase();
  const seen = new Map();
  for (const m of catalogue?.merchants ?? [])
    for (const t of m.teaches ?? []) {
      const name = t.skill || t.spell;
      if (!name || !name.toLowerCase().includes(q)) continue;
      if (!seen.has(name)) seen.set(name, { name, kind: t.kind ?? null, num: t.num ?? null,
                                            price: t.price ?? null });
    }
  const hits = [...seen.values()];
  const one = hits.find(h => h.name.toLowerCase() === q) ?? (hits.length === 1 ? hits[0] : null);
  return one ? { ...one, ambiguous: null }
             : { name: String(want), kind: null, num: null, price: null,
                 ambiguous: hits.length ? hits.map(h => h.name) : [] };
}

// WHERE THE BANKS ARE AND WHICH ACCOUNT EACH ONE IS. Two facts with two owners, joined
// on the banker's name: the ROOMS come from the merchant catalogue, where one was seen
// standing, and the ACCOUNT NUMBERS from m59-bank.mjs, which is the only place in this
// repository that knows Barloque pays into the Tos account. Neither is restated here,
// because a quantity with two homes in this repository has always ended up with two
// answers.
const BANK_ROOMS = (CATALOGUE?.merchants ?? [])
  .filter(m => m.room != null && BANKERS.some(b => b.banker === m.name))
  .map(m => ({ room: m.room, banker: m.name,
               account: accountOf(BANKERS.find(b => b.banker === m.name).bank) }));

// TRAVEL IS FLAKY IN THE MIDDLE AND RESUMABLE, so retry rather than give up: a
// multi-hop route fails part-way with "start is outside the room grid" when the
// character's position has not settled after an edge crossing, and the next attempt
// continues from wherever it actually got to.
//
// AND IT UNDER-REPORTS ARRIVAL, so ask where the character is rather than believing the
// flag. Used for both legs of the errand — the bank and the shop — because a trip that
// gives up on the first refusal is how the supervisor spent cycle after cycle walking
// characters at the same refused exit in Marion, learning nothing between attempts.
// A JOURNEY IS LONGER THAN AN RPC TIMEOUT, and treating the timeout as a refusal is how
// this errand cancelled itself on a walk that was going fine.
//
// `call` defaults to 30s. A cross-map trip — the valley to Cor Noth, say — takes minutes,
// so `AbortSignal.timeout` fired, the catch below turned it into `{arrived: false}`, and
// the loop reported "travel refused" about a character that was still walking. Worse, it
// then RE-ISSUED travel twice more into a journey already in flight, which is the exact
// thing m59-fleetscript.mjs compiles in a guarantee against: "travel issued once and never
// re-issued while walking".
//
// So: the travel call gets a timeout sized to a journey, and a timeout is no longer read
// as a refusal — before retrying, ask where the character actually is, because "the answer
// did not arrive" and "the walk failed" are different facts and only one of them is a
// reason to walk again.
const TRAVEL_TIMEOUT_MS = 8 * 60_000;

async function goTo(agent, room, tries = 3) {
  let why = null;
  for (let i = 0; i < tries; i++) {
    let timedOut = false;
    const t = await call('travel', { agent, to: room, max_hops: 20 }, TRAVEL_TIMEOUT_MS)
                    .catch(e => { timedOut = /abort|timeout|timed out/i.test(e.message ?? '');
                                  return { arrived: false, why: e.message }; });
    if (t.arrived) return { ok: true, why: null };
    const stuck = (t.log || []).filter(h => !h.ok).slice(-1)[0];
    why = stuck ? `${stuck.from} -> ${stuck.to}: ${stuck.also_tried?.[0]?.why ?? 'refused'}`
                : (t.why || 'travel refused');
    // ARRIVAL IS A FACT ABOUT THE WORLD, not about whether our call returned. Check it
    // first, and note `room.num` — `where.num` is not a field the status tool returns, so
    // the old test never fired and a character standing in the right room was walked again.
    const st = await call('status', { agent, brief: true }).catch(() => null);
    const at = st?.room?.num ?? st?.where?.num;
    if (at === room) return { ok: true, why: null };
    if (timedOut) why = `travel did not answer within ${TRAVEL_TIMEOUT_MS / 60000}min ` +
                        `(last seen in ${at ?? 'an unknown room'})`;
    await sleep(1500);
  }
  return { ok: false, why };
}

// KNOWING IT IS NOT THE SAME AS BEING GOOD AT IT, and this asks the first question.
// `known_only:false` on purpose: the list is plSkills/plSpells, so an entry sitting at
// ability 0 is still a skill the character HAS, and filtering those out would send it
// back to buy something it already owns — which the merchant would then silently refuse
// to offer, and the errand would report as "not sold here".
async function knows(agent, name, { refresh = false } = {}) {
  const q = String(name).toLowerCase();
  const a = await call('abilities', { agent, name, known_only: false, ...(refresh ? { refresh: true } : {}) })
                  .catch(() => null);
  if (!a) return null;                              // unknown, which is not "no"
  return [...(a.skills ?? []), ...(a.spells ?? [])]
    .some(r => String(r.name ?? '').toLowerCase() === q);
}

async function outfit(row) {
  const who = row.character || row.agent;

  // TRY TO WEAR IT BEFORE ASKING WHETHER IT IS OWNED — BECAUSE BROKEN IS ONLY DISCOVERED
  // BY TRYING.
  //
  // A ruined piece is called "leather armor" like any other, and the only record that it
  // is useless is the keeper's condemnation set, which is built when the SERVER refuses to
  // wear it and is rebuilt from empty on every broker restart. So straight after a restart
  // — which is most of the time, since the fleet restarts often — a character carrying
  // nothing but a broken armour reads as fully stocked, this returns "already stocked",
  // and it goes back out bare.
  //
  // That is why re-kitting has needed a human in the loop all session: the supervisor runs
  // this tool on a timer, it reported "already stocked" for Rowlf, and only a hand-run
  // `wear_best` — which condemns the piece — made a second run buy anything. Gear breaks
  // here about once a pass, so a check that cannot see broken gear is the check that
  // matters least.
  //
  // Doing it first costs one call and turns a two-step into one: the refusal happens, the
  // item is condemned, and the `inventory` read below carries `broken` on the row. It is
  // also worth doing on its own account — owning is not wearing, and a character that
  // simply forgot to put its armour on is fixed here without buying anything.
  if (!DRY && WANT_GEAR) {
    await call('wear_best', { agent: row.agent }).catch(() => null);
    await call('equip_best', { agent: row.agent }).catch(() => null);
  }

  const inv0 = await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }));
  let items = inv0.items || [];
  // THIS CHARACTER'S OWN LIST IF IT HAS ONE, keyed on the character name rather than the
  // agent handle — `t1` is this machine's word for a roster slot, "Kermit" is who it is.
  // Null falls through to the fleet default, which is what every character got before.
  // `row.character`, not `who` — `who` falls back to the agent handle for a character that
  // is not in game, and a loadout is looked up by the character's name.
  const loadout = row.character ? loadoutFor(row.character) : null;
  const wants = wantsFor(loadout);
  const purchaseStatus = await call('autopilot', { agent: row.agent, action: 'status' }).catch(() => null);
  const mayBuyWeapons = purchaseStatus?.policy?.buyWeapons !== false;
  // DEFENCE FIRST, WHATEVER ORDER THE LIST CAME IN.
  //
  // The header of this file states the principle — "a weapon changes how fast something
  // dies; armour changes whether you are still standing when it does" — and the fleet
  // default WANTS is written armour, shield, weapon to match. A LOADOUT is not: its order
  // is whatever somebody typed into the planner, and wantsFor preserves it.
  //
  // Kermit paid for that exactly. It reached Rook with 835 shillings, bought the mace its
  // loadout listed first for 100, and was then 65 SHORT of the 800 leather — so it walked
  // away armed and bare, having spent on the cheap half the money that would have
  // armoured it. With one purse and two wants, the order IS the decision.
  //
  // Sorted here rather than in wantsFor, so a loadout keeps meaning what it says about
  // WHICH items are wanted and only the sequence of spending is imposed.
  const SLOT_ORDER = { armour: 0, shield: 1, weapon: 2 };
  // DOWN TO THE LAST WORKING WEAPON IS A REASON TO GO, AND `missingFor` CANNOT SAY IT.
  //
  // That test is count-blind — it asks whether the pack holds ANYTHING matching the want,
  // so a character with one mace and a character with four both read "already stocked"
  // and neither travels. Combined with a fallback that accepts the whole family, an AXE
  // satisfies the mace want too, which is how Kermit, Camilla, Sweetums and Bunsen were
  // all reported stocked while carrying no blunt weapon at all against skeletons that
  // resist edges at 70%.
  //
  // The weapon is the one slot where that matters, because it is the one that is
  // CONSUMED — see the spares purchase below. So running down to the last one is treated
  // as missing, which is what makes the trip happen; the spares loop then fills to depth
  // once the character is standing at the counter.
  //
  // Deliberately `<= 1` rather than `< WEAPON_SPARES`: the trigger is "about to be
  // fighting bare-handed", not "not completely stocked". Sending twenty-one characters
  // shopping every time one of them is a mace short of ideal costs more farming than the
  // spare is worth, and this tool stops a keeper to run.
  const bluntDepth = (list) => {
    const w = (list || WANTS).find(x => x.slot === 'weapon');
    return w ? (items || []).filter(i => w.re.test(nameOf(i)) && !i.broken).length : 0;
  };
  const runningOut = WANT_GEAR && WEAPON_SPARES > 0 && bluntDepth(wants) <= 1;
  const allMissing = WANT_GEAR
    ? (() => {
        const m = missingFor(items, wants);
        const weaponWant = (wants || WANTS).find(w => w.slot === 'weapon');
        return runningOut && weaponWant && !m.some(w => w.slot === 'weapon')
          ? [...m, { ...weaponWant, what: `${weaponWant.what} (down to ${bluntDepth(wants)})` }]
          : m;
      })()
    : [];
  const suppressedWeapons = allMissing.filter(w => w.slot === 'weapon' && !mayBuyWeapons);
  const missing = WANT_GEAR
    ? allMissing.filter(w => w.slot !== 'weapon' || mayBuyWeapons).sort((a, b) =>
        (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9))
    : [];

  // WHAT IT DOES NOT KNOW YET. Asked before anybody walks anywhere: a character that
  // already has the skill costs a whole trip to find that out at the shop, and the shop
  // says so by not offering it, which reads exactly like the merchant not selling it.
  const toLearn = [];
  for (const want of LEARN) {
    const ab = abilityWanted(want);
    if (ab.ambiguous) {
      return `${who}: "${want}" is ` + (ab.ambiguous.length
        ? `ambiguous — did you mean ${ab.ambiguous.join(', ')}?`
        : 'not taught by anybody in the catalogue (names are the game\'s own: ' +
          '"mace fighting", not "proficiency mace")');
    }
    const has = await knows(row.agent, ab.name);
    if (has === true) continue;
    toLearn.push({ ...ab, uncertain: has === null });
  }

  if (!missing.length && !toLearn.length) {
    if (suppressedWeapons.length)
      return `${who}: paid weapon buying is disabled by strategy`;
    if (LEARN.length) return `${who}: already knows ${LEARN.join(', ')}`;
    // Owning is not wearing. Even a fully-stocked character is worth a wear_best.
    if (!DRY) {
      const w = await call('wear_best', { agent: row.agent }).catch(() => null);
      await call('equip_best', { agent: row.agent }).catch(() => null);
      if (w?.worn?.length) return `${who}: already stocked — put on ${w.worn.map(x => x.name).join(', ')}`;
    }
    return `${who}: already stocked`;
  }
  if (DRY) return `${who}: would buy ${[...missing.map(m => m.what),
    ...toLearn.map(a => `${a.name} (${a.price ?? '?'}sh)`)].join(', ')}`;

  // Remember EXACTLY what the keeper was running so the errand cannot quietly re-write a
  // character's orders. Stopping happens INSIDE the ownership lease, below, so a refused
  // claim never leaves the keeper stopped. The orders are restored in the finally.
  const was = purchaseStatus ?? await call('autopilot', { agent: row.agent, action: 'status' }).catch(() => null);
  const log = [];
  const body = async () => {
    // Inside the ownership lease now: stop the keeper so this errand drives the character.
    await call('autopilot', { agent: row.agent, action: 'stop' }).catch(() => {});
    // A FAILED READ IS NOT "DOES NOT KNOW IT". Going anyway is right — the merchant will
  // decline to offer something already known and the check afterwards will say so — but
  // the log has to distinguish it from a character we actually looked at.
  for (const a of toLearn) if (a.uncertain) log.push(`could not read abilities first, buying ${a.name} blind`);
  try {
    // Where to shop. An explicit room wins; otherwise ask which merchants sell what we
    // lack and take the fewest hops, which is the same question gear-buying always is.
    let shopRoom = AT;
    let candidates = AT != null ? [AT] : [];
    if (shopRoom == null) {
      const seen = new Map();
      // WHEN THERE IS SOMETHING TO LEARN, THE TRIP IS TO THE TEACHER. Gear is sold in
      // every town and skills mostly are not — block has exactly one seller in the whole
      // game — so the scarce end of the errand picks the destination and the other end
      // takes what it can get from the same room.
      for (const a of toLearn) {
        const m = await call('merchants', { agent: row.agent, teaches: a.name }).catch(() => ({ matches: [] }));
        for (const x of m.matches || []) {
          if (x.room != null) { seen.set(x.room, x); continue; }
          // A CLASS THE WORLD WAS NOT SHOWING STILL HAS AN ADDRESS, if the same man
          // also stands somewhere under another class. This is the Jonas case: the
          // entry that matched may be the wanderer, whose room is a rumour, while his
          // stationary self is in a bar with a room number.
          for (const alt of x.also ?? []) if (alt.room != null) seen.set(alt.room, { ...alt, merchant: alt.cls });
        }
      }
      for (const what of (missing.length ? ['armor', 'shield', 'mace'] : [])) {
        const m = await call('merchants', { agent: row.agent, sells: what }).catch(() => ({ matches: [] }));
        for (const x of m.matches || []) if (x.room != null) seen.set(x.room, x);
      }
      // A WANDERING MERCHANT IS NOT A DESTINATION.
      //
      // The index records where a merchant was SEEN, which is the right thing for the
      // stationary ones — every other NPC in this game stays put — and completely wrong
      // for the six the game files keep under `monster/towns/wanderer/`: DarkWizard,
      // Heretic, HunterGhost, Izzio, JealousGeneral and Minstrel, each declared `is
      // Wanderer`.
      //
      // Izzio is the one that matters, because he is the only wanderer that sells gear —
      // leather armour, a metal shield, a long sword — and he circulates between Lake of
      // Jala's Song, the Main Gate of Barloque, the King's Way, the Temple of Shal'ille
      // and West Merchant Way through Ilerian Woods. He was last seen at 593, so that is
      // where the errand went, and the log filled with "nobody here sells anything (room
      // 593)" — a true statement about an empty gate, walked to on purpose.
      //
      // So wanderers go LAST rather than being dropped. Walking to where one was last
      // standing is a coin toss, which is why it must not be the first choice — but it
      // is not worthless, and for SKILLS there is sometimes no other seller in the game.
      // A coin toss beats no option at all.
      //
      // The per-candidate check below already handles him not being there: reaching a
      // room and finding nobody who sells is treated exactly like failing to reach it,
      // and the loop moves on. So a wanderer at the end of the list costs one wasted
      // trip in the worst case and buys the only source of a skill in the best.
      //
      // WHO WALKS IS NOW A FACT IN THE CATALOGUE rather than a list retyped here — it is
      // derived from `is Wanderer` in the source, so a seventh wanderer added to the
      // game arrives with the next build instead of being silently treated as an
      // address. The old list stays as the answer for a catalogue built before that.
      const WANDERERS = new Set(['DarkWizard', 'Heretic', 'HunterGhost',
                                 'Izzio', 'JealousGeneral', 'Minstrel']);
      const isWanderer = x => x?.wanders ?? WANDERERS.has(String(x?.merchant ?? x?.cls ?? x?.class ?? ''));

      // "I CANNOT ANSWER" IS NOT "THERE IS NO ROUTE", and conflating them silently
      // cancelled this whole errand for every character on the fleet.
      //
      // Under the keeper-process session driver the World lives in the KEEPER, and the
      // broker's `map` answers `route: {found: null, reason: "...driven by a keeper
      // process; ask it over /action {name:\"route\"} — the broker holds a snapshot, not
      // a World"}`. `found` is null rather than false, which is the tool being explicit
      // that it did not decide. This test read it as falsy, dropped every candidate, and
      // reported "no teacher of punch reachable" — for Rook, who is stationary in room
      // 154 and whom the `merchants` tool had just returned.
      //
      // So an unanswerable route keeps the candidate with unknown cost, ordered AFTER
      // every candidate that priced properly, and travel decides for real: `travel` is
      // executed by the keeper, which does have a World and does know the way. A genuine
      // `found: false` is still a refusal — that one is an answer.
      const priceAll = async (list) => {
        const out = [];
        for (const m of list) {
          const rt = await call('map', { agent: row.agent, to: m.room }).catch(() => null);
          const route = rt?.route;
          if (route?.found) { out.push({ room: m.room, hops: route.hops.length, roams: isWanderer(m) }); continue; }
          if (route && route.found == null)
            out.push({ room: m.room, hops: Number.POSITIVE_INFINITY, roams: isWanderer(m), unpriced: route.reason ?? true });
        }
        return out.sort((a, b) => a.hops - b.hops);
      };
      const settled = await priceAll([...seen.values()].filter(x => !isWanderer(x)));
      const roaming = await priceAll([...seen.values()].filter(isWanderer));
      const priced = [...settled, ...roaming];       // stationary first, always

      if (!priced.length)
        return `${who}: no ${toLearn.length ? `teacher of ${toLearn.map(a => a.name).join(', ')}` : 'smith'} reachable`;
      if (!settled.length)
        log.push('no stationary seller reachable — trying a wanderer, which may not be there');
      candidates = priced.map(p => p.room);
      shopRoom = candidates[0];
    }

    // GO PAST A BANK ON THE WAY, IF THE PRICE IS KNOWN AND THE POCKET IS NOT DEEP
    // ENOUGH. Gear-buying could leave this until it arrived, because a smith usually
    // has a bank in the same town and there was no fixed bill to meet. Neither is true
    // of a skill: the price is exact, it is 500 for the cheapest one in the game, and
    // the fleet walks around with a couple of hundred. So this is the difference between
    // the errand working and twenty characters walking to Jasper to be told nothing.
    //
    // The account is the character's OWN — three towns share bank 1 and Ko'catan is
    // bank 2, so a Ko'catan balance cannot be drawn in Jasper and the errand must not
    // pretend otherwise. A character whose account we have never heard a banker state
    // still gets a try at the nearest bank of either kind; being wrong there costs a
    // walk, and being sure is not on offer.
    // AND GEAR NEEDS THE BANK TOO — THE REASON IT DIDN'T WAS AN ASSUMPTION, NOT A PRICE.
    //
    // This used to bill only for skills, on the grounds quoted above: a smith usually has
    // a bank in the same town, so a gear errand could sort its money out on arrival. The
    // first half is true and the second never happened — nothing walks to that bank. Gonzo
    // was driven to the Royal Blacksmith of Barloque carrying 453 shillings, with 2,622 in
    // the bank, and leather armour costs 480. He came back with nothing, and the run
    // printed no line at all to say why, because "could not afford it" was not a case it
    // had. Piggy is now in the same state, and the fleet keeps producing them: armour
    // breaks, gets condemned, and the replacement is a 480 purchase against a purse the
    // walking-money rule holds at a few hundred.
    //
    // A gear bill cannot be exact — the shop list is only read on arrival, and WANTS has
    // no prices in it — so this is a FLOOR, not a quote: below it the errand is at real
    // risk of arriving unable to buy, and a detour past a bank costs a walk while arriving
    // broke costs the whole trip. The withdrawal that follows is sized by WITHDRAW anyway.
    //
    // 2000 BECAUSE THE PRICE IS NOT 480, AND THE SPREAD IS ALMOST FOURFOLD.
    //
    // 480 is Jasper's, and it is the figure every report in this repository quotes. The
    // prices actually paid for one leather armor, all of them observed live: 480 at Quintor
    // in Jasper, 640 at Colhorr, 800 at Rook's, and 1800 from Fehr'loi Qan in Barloque. A
    // smith is chosen by how far away it is (`priceAll` sorts on hops, whatever its name
    // suggests) and not by what it charges, so the floor has to clear the DEAREST counter
    // the router might pick, not the cheapest one on record.
    //
    // At 700 this failed twice, the same way both times: the withdrawal is sized from the
    // floor, so Lew walked to Fehr'loi Qan with 1000 and Rowlf with 1676, and both came
    // home still bare while holding thousands in the bank. Over-withdrawing at a cheap
    // smith costs nothing that matters — the surplus is banked on the next town trip, and
    // the only real exposure is carrying it until then, which is a fraction of what going
    // unarmoured costs when armour here breaks about once a pass.
    const GEAR_FLOOR = 2000;
    const bill = toLearn.length ? toLearn.reduce((t, a) => t + (a.price ?? 0), 0)
               : (missing.length ? GEAR_FLOOR : 0);
    if (bill > 0) {
      let have = purseOf((await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || []);
      if (have < bill) {
        const mine = row.banked?.account ?? null;
        const usable = BANK_ROOMS.filter(b => !mine || b.account === mine);
        const routed = [];
        for (const b of (usable.length ? usable : BANK_ROOMS)) {
          const rt = await call('map', { agent: row.agent, to: b.room }).catch(() => null);
          if (rt?.route?.found) routed.push({ ...b, hops: rt.route.hops.length });
        }
        routed.sort((x, y) => x.hops - y.hops);
        if (!routed.length) log.push(`short ${bill - have}sh and no bank reachable`);
        for (const b of routed.slice(0, 2)) {
          if (!(await goTo(row.agent, b.room)).ok) continue;
          // ASK FOR WHAT IS THERE. A BANK REFUSES AN OVER-WITHDRAWAL, IT DOES NOT PAY OUT
          // THE BALANCE.
          //
          // This asked for WITHDRAW (1000) flat, with a margin on top, because the trip
          // back is free and a second trip is not. That is right for a rich character and
          // it is a total refusal for everybody else: Zoot has 813 banked, was asked for
          // 1000 at Yevitan and then at Skivlat, and both "handed over nothing" — so the
          // errand walked two banks, collected two refusals, reached Rook and came back
          // STILL MISSING leather armour with 813 shillings sitting in the account the
          // whole time. Nothing errored; the log line for a refusal and for an empty
          // account are the same sentence.
          //
          // The balance is only known when a banker has said it out loud (see the bank
          // trap in CLAUDE.md — there is no packet for it), so when it is unknown this
          // still asks for the full amount, which is the old behaviour and the only thing
          // available. When it IS known, never ask for more than it.
          const balance = row.banked?.balance ?? null;
          const want = Math.min(EXACT_FUNDING ? Math.max(0, bill - have)
                                             : Math.max(WITHDRAW, bill - have + 200),
                                balance == null ? Infinity : balance);
          if (want <= 0) { log.push(`nothing banked at ${b.banker} to draw on`); continue; }
          await call('bank', { agent: row.agent, action: 'withdraw', amount: want }).catch(() => null);
          await sleep(800);
          const now = purseOf((await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || []);
          log.push(now > have ? `withdrew ${now - have}sh at ${b.banker}`
                              : `${b.banker} handed over nothing (account ${b.account})`);
          // MOVE THE BASELINE, or the second counter reports the first one's money.
          //
          // `have` was read once before this loop and never updated, so after a successful
          // withdrawal at Yevitan the comparison at Skivlat was still against the ORIGINAL
          // purse — `now > have` stayed true and the log said "withdrew 814sh at Yevitan,
          // withdrew 814sh at Skivlat" for one withdrawal of 814. Jasper, Tos and Barloque
          // share one account, so the second counter had nothing left to give and the line
          // claiming otherwise is the only thing that was wrong. A stale baseline reads
          // exactly like a real gain, which is why it survived a live run unnoticed.
          have = now;
          if (now >= bill) break;
        }
      }
    }

    // IF THAT SHOP CANNOT BE REACHED, TRY THE NEXT ONE.
    //
    // Picking the nearest smith and giving up on it is how the supervisor spent cycle
    // after cycle walking characters to Marion and failing at the same refused exit:
    //
    //   Bunsen: could not reach room 201 — Marion -> Ye Olde Slasher Salesman:
    //           You are unable to go anywhere.
    //
    // Every ninety seconds, for both members of a pair, with nothing learned between
    // attempts. Nearest is a preference and not a requirement — a shop three rooms
    // further away that can actually be entered is strictly better than one next door
    // that refuses, and `priced` is already sorted, so the next candidate is free.
    // ARRIVING IS NOT THE SAME AS FINDING A SHOPKEEPER, and treating them as the same
    // is why outfitting quietly did nothing about half the time.
    //
    // The candidate list comes from the merchant index, which records where a merchant
    // was SEEN. Izzio really is recorded at 593 selling leather armour and a shield —
    // and a character sent there was told "nobody here sells anything (room 593)" and
    // the whole errand ended, on the first candidate, with two more in the list unread.
    //
    // A shop we reached but cannot buy in is worth exactly what a shop we could not
    // reach is worth, and the loop already knows what to do with the second: try the
    // next one. This says so for the first as well.
    let arrived = false, tried = [], seller = null;
    for (const room of (candidates.length ? candidates : [shopRoom]).slice(0, 3)) {
      shopRoom = room;
      const got = await goTo(row.agent, shopRoom);
      if (!got.ok) { tried.push(`${room} (${got.why})`); continue; }

      // A FAILED READ IS NOT AN EMPTY ROOM. This caught the error and substituted
      // `{objects: []}`, which is indistinguishable from a room with no merchant in it
      // — so a timed-out look reported the shop as empty and the character walked away
      // from a shopkeeper it was standing next to.
      const seen = await call('look', { agent: row.agent }).catch(e => ({ error: e.message }));
      if (seen.error) {
        tried.push(`${room} (could not read the room: ${seen.error})`);
        continue;
      }
      seller = (seen.objects || []).find(o => (o.can || []).includes('buy'));
      if (!seller) {
        // SAY WHAT WAS ACTUALLY THERE. "nobody here sells anything" is unfalsifiable
        // from a log — it cannot be told apart from a bad room read, a merchant that
        // moved, or an affordance we failed to derive. The contents make it debuggable.
        const what = (seen.objects || []).map(o => o.name).filter(Boolean).slice(0, 8);
        tried.push(`${room} (reached it; ${what.length ? 'saw ' + what.join(', ') : 'room read as empty'})`);
        continue;
      }

      // AND A SHOPKEEPER WHO DOES NOT STOCK IT IS NOT A SHOP EITHER.
      //
      // The comment above says a shop we cannot buy in is worth what a shop we could not
      // reach is worth — and then the loop stopped at the first counter with a `buy`
      // affordance, whether or not it sold the thing. Fehr'loi Qan at 113 is the nearest
      // smith to most of the fleet and does not stock leather at all: Kermit, Bunsen and
      // Piggy each withdrew their savings, walked there, were told "leather armour: not
      // sold here", and came home bare with two candidates in the list unread. Three of
      // four re-kits in one run, and the same shape that sent Lew to a 1800-shilling
      // counter and Rowlf after him.
      //
      // So peek at the list before settling. The read is one call and it is made again
      // below for the real purchase — cheap against a walk across the world. The test
      // uses the SAME wearable predicate as the buy loop, or a smith stocking nothing but
      // chain would count as supplying armour and the character would arrive, refuse it,
      // and leave with nothing again.
      if (WANT_GEAR && missing.length) {
        const peek = await call('shop', { agent: row.agent, seller: seller.id }).catch(() => null);
        const offers = peek?.items || [];
        const supplies = missing.some(w =>
          offers.some(i => (w.re.test(nameOf(i)) || w.fallback.test(nameOf(i))) && wearableItem(i)));
        if (!supplies) {
          tried.push(`${room} (${offers.length} on the shelf, none of ${missing.map(x => x.what).join('/')})`);
          seller = null;
          continue;
        }
      }

      // WALK TO THE SHOPKEEPER BEFORE TRADING WITH IT.
      //
      // Nothing in UserBuy or GetForSale (monster.kod:4818) checks distance, so buying
      // does not strictly need this — but every NPC in this game is stationary, so
      // standing next to one costs a couple of seconds and removes a whole class of
      // "it should have worked" from the log. It is also simply what a player does, and
      // the offer/trade paths are less forgiving than the buy path.
      //
      // Failure here is not fatal: if the walk is refused we are still in the room with
      // the merchant, which is where the old code traded from anyway.
      if (seller.col != null && seller.row != null) {
        const w = await call('walk_to', { agent: row.agent, col: seller.col, row: seller.row })
                        .catch(e => ({ arrived: false, why: e.message }));
        // ARRIVING IS THE WRONG TEST HERE. The merchant is STANDING on the square we
        // aimed at, so the last step is refused and walk_to honestly reports
        // arrived:false — while we are in fact standing next to it, which is the thing
        // we wanted. Measure the distance instead of believing the flag, or the log
        // fills with failures that are successes.
        const at = w?.position ?? null;
        const gap = at ? Math.max(Math.abs(at.col - seller.col), Math.abs(at.row - seller.row)) : null;
        const name = seller.name ?? 'the merchant';
        log.push(gap != null && gap <= 1 ? `standing with ${name}`
               : gap != null            ? `${gap} squares from ${name} — trading from here`
                                        : `could not walk to ${name} (${w?.reason ?? w?.why ?? 'refused'}) — trading from here`);
      }
      arrived = true;
      break;
    }
    if (!arrived) return `${who}: no ${toLearn.length ? 'teacher' : 'smith'} worked out — tried ${tried.join('; ')}`;
    log.push(`at ${shopRoom}`);

    // SELL FIRST, ALWAYS, AND BEFORE THE BANK. Two reasons, and the second is the one
    // that was costing the fleet every trip:
    //
    //   The money. What a farming character carries is usually worth more than the
    //   armour, so a sale often removes the need for a bank trip entirely.
    //
    //   THE SPACE. `ReqNewHold` refuses a purchase when the pack cannot hold the goods,
    //   and the merchant answers "Perhaps you carry too much?" — a sentence spoken to the
    //   room, not an error, so the buy reports nothing wrong and the errand walks home
    //   empty. Measured this session: Kermit at Rook, Fozzie and Floyd at Quintor, Lew at
    //   Fehr'loi Qan, all refused in one run, while Floyd carried SEVEN long swords it had
    //   looted and never sold. Selling afterwards cannot help — by then the buy has failed.
    //
    // AND THE OLD `keep` LIST WAS THE REASON THEY PILED UP. It held back anything matching
    // sword/mace/axe/hammer/armor/shield, which is exactly the loot this trip exists to
    // convert, so a character could sell reagents to fund a mace it then had no room for.
    // It is gone rather than trimmed: `sell_all` already honours this character's LOADOUT
    // — which names the spares to shed and the floors to protect — and what is worn or
    // wielded is protected by the server's own use list, which no list here can override.
    // A second, coarser opinion about what to keep could only disagree with the loadout,
    // and when it did the loadout lost.
    items = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    let money = purseOf(items);
    // MAX_WEAPONS MUST BE SAID OUT LOUD HERE. `sell_all` defaults it to null, and null
    // means "no weapon limit is configured" — which keeps EVERY weapon in the pack. The
    // keeper always passes its own policy (2 on this fleet) so its town trips shed spares;
    // an errand calling the tool directly gets the permissive default instead. Floyd hit
    // exactly that: seven looted long swords, all "held back", a pack too full to accept
    // the mace this trip existed to buy, and a sale that reported nothing to sell.
    // Equipped and wielded weapons are kept regardless — plUsing is the server's list.
    const preSale = await call('sell_all', { agent: row.agent, merchant: seller.id,
                                             max_weapons: WEAPONS_TO_KEEP })
                          .catch(() => null);
    if (preSale?.total_received) {
      money += preSale.total_received;
      log.push(`sold ${(preSale.sold || []).length} item(s) for ${preSale.total_received}sh`);
    } else if (preSale?.not_offered?.length) {
      // Nothing this counter deals in. Worth saying, because it is the difference between
      // "there was nothing to sell" and "we brought the wrong goods to the wrong shop".
      log.push(`nothing ${preSale.merchant?.class || 'here'} buys (${preSale.not_offered.length} held back)`);
    }

    // FUND IT. The purse first, then the bank we are standing next to, then a partner.
    if (money < WITHDRAW / 2) {
      const b = await call('bank', { agent: row.agent, action: 'withdraw', amount: WITHDRAW })
                      .catch(e => ({ error: e.message }));
      if (b?.balance != null || /shilling/i.test(String(b?.said ?? ''))) {
        await sleep(800);
        items = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
        const now = purseOf(items);
        if (now > money) { log.push(`withdrew ${now - money}sh`); money = now; }
      } else if (b?.error) {
        // Not a failure worth stopping for: there may be no bank in this room, or the
        // account may be in another town. Say which, and carry on with what we carry.
        log.push('no withdrawal here (each town banks separately)');
      }
    }

    const shop = await call('shop', { agent: row.agent, seller: seller.id }).catch(() => ({}));
    const stock = shop.items || [];
    for (const w of missing) {
      // Prefer the exact thing asked for; fall back to the same slot if the shop has
      // no leather but does have something wearable.
      // DO NOT BUY ARMOUR THE WEARER WILL REFUSE — THE FALLBACK BOUGHT THE WORST PIECE IN
      // THE GAME AT THE HIGHEST PRICE PAID ALL SESSION.
      //
      // The armour want is "leather armor" with a fallback of /armor|armour|mail/, so when
      // a smith has no leather the fallback takes anything armour-shaped. Floyd withdrew
      // 1800 at Yevitan and bought CHAIN ARMOR at 1800 from Fehr'loi Qan — and `wear_best`
      // then refused it, verbatim: "the best in the pack is no better than bare skin, so it
      // stays off", score -30. He walked home with an empty purse, no armour, and a
      // heavy thing he will carry for ever.
      //
      // This is the heavy-armour trap in CLAUDE.md arriving through the buy path rather
      // than the wear path: viDefense_base is +50 for leather and -50 for chain, and a
      // character fighting from a safe spot intends to be hit zero times, which absorption
      // does nothing about. wear_best has always known this; the shopping did not, and the
      // two disagreeing costs real money every time a smith is out of leather.
      //
      // So the same ranking decides both. Anything scoring at or below bare skin is not a
      // fallback, it is a purchase to regret — better to report the slot unfilled and let
      // the next candidate smith or the next trip supply leather.
      const wearable = (i) => {
        const k = armourKind(nameOf(i));
        return !k || armourScore(k) > 0;      // not armour at all, or armour worth wearing
      };
      const pick = (re) => stock.filter(i => re.test(nameOf(i)) && wearable(i))
                                .sort((a, b) => (a.cost ?? a.price ?? 9e9) - (b.cost ?? b.price ?? 9e9))[0];
      const opt = pick(w.re) || pick(w.fallback);
      if (!opt) { log.push(`${w.what}: not sold here`); continue; }
      const cost = opt.cost ?? opt.price ?? 0;
      if (cost > money) { log.push(`${w.what}: ${cost}sh, only ${money}sh`); continue; }
      // SAY WHAT ARRIVED, NOT WHAT WAS ORDERED. This logged `bought X @N` unconditionally
      // with the reply thrown away, so a purchase that took the money and delivered
      // nothing read exactly like one that worked. Measured: Rizzo withdrew 1744sh, the
      // line said `bought hammer @810`, and its pack held no weapon at all afterwards —
      // 810 shillings gone, still fighting with its fists, and the only hint was the
      // verification further down saying STILL MISSING.
      //
      // `got` is the broker's list of what actually entered the pack, off the server's own
      // `got` events. An empty one is the silent refusal this whole file exists to catch:
      // a merchant declining is a sentence spoken to the room, never an error on the wire.
      const res = await call('shop', { agent: row.agent, seller: seller.id, buy_ids: [opt.id] })
                          .catch(e => ({ error: e.message }));
      const got = Array.isArray(res?.got) ? res.got : [];
      money -= cost;
      if (got.length) log.push(`bought ${nameOf(opt)} @${cost}`);
      else log.push(`*** ASKED FOR ${nameOf(opt)} @${cost} AND GOT NOTHING` +
                    (res?.clamped?.length ? ` — clamped by ${[...new Set(res.clamped
                       .flatMap(c => c.limited_by || []))].join('/') || 'purse/weight/bulk'}` : '') +
                    (res?.messages?.length ? ` — the counter said: ${res.messages.join('; ').slice(0, 80)}` : '') +
                    ' ***');
    }

    // A WEAPON IS A CONSUMABLE HERE, AND ARMOUR IS NOT. Buy spares of the weapon.
    //
    // This fleet re-armed with maces four times in one afternoon and was back on looted
    // long swords within hours each time, and the reason is not that anything sells or
    // drops them deliberately. A weapon in use SHATTERS — and when it does the server
    // unequips it and leaves it in the pack under its own name, because `weapon.kod:788`
    // changes only the ICON. So the broken mace still out-scores nothing, `equip_best` is
    // refused with no message at all, and the keeper's 120-second sweep
    // (`dropBrokenEverySec`) drops it as junk. The character then wields the best thing
    // left, which is whatever it last looted — a long sword, 70% resisted by the very
    // creature that broke the mace.
    //
    // THE LOOT NEVER BREAKS, WHICH IS WHY THE PACK FILLS WITH IT. Long swords are never
    // swung, so they accumulate — nineteen on one character — while the one weapon doing
    // the work is consumed. Buying a single replacement per trip loses that race.
    //
    // So the weapon slot, and only the weapon slot, is stocked to a depth. Armour is not
    // treated this way on purpose: it wears but is not destroyed the same way, and a spare
    // suit is dead weight in a pack that is already the binding constraint.
    if (WEAPON_SPARES > 0 && !DRY) {
      const want = missing.find(w => w.slot === 'weapon') ??
                   { re: /mace|hammer/i, fallback: /mace|hammer|axe/i, what: 'weapon', slot: 'weapon' };
      const held = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
      const haveBlunt = held.filter(i => want.re.test(String(i.name || ''))).length;
      const shortfall = Math.max(0, WEAPON_SPARES - haveBlunt);
      for (let n = 0; n < shortfall; n++) {
        const opt = stock.filter(i => want.re.test(nameOf(i)))
                         .sort((a, b) => (a.cost ?? a.price ?? 9e9) - (b.cost ?? b.price ?? 9e9))[0];
        if (!opt) break;
        const cost = opt.cost ?? opt.price ?? 0;
        // Spares are the FIRST thing to give up when money is short — the trip has already
        // bought what the character was actually missing.
        if (cost > money) { log.push(`spare ${nameOf(opt)}: ${cost}sh, only ${money}sh left`); break; }
        const res = await call('shop', { agent: row.agent, seller: seller.id, buy_ids: [opt.id] })
                            .catch(() => ({}));
        money -= cost;
        if (!(Array.isArray(res?.got) && res.got.length)) {
          log.push(`spare ${nameOf(opt)} @${cost}: got nothing` +
                   (res?.messages?.length ? ` — ${res.messages.join('; ').slice(0, 60)}` : ''));
          break;   // a refusal will refuse the next one too; do not spend the trip on it
        }
        log.push(`spare ${nameOf(opt)} @${cost}`);
      }
    }

    // LEARN IT. The same list and the same purchase — a skill in the offer list is an
    // id with a name and a cost, exactly like a hat.
    //
    // AN ABILITY THAT IS NOT IN THE LIST WAS NOT REFUSED; IT WAS NEVER OFFERED, and the
    // three reasons are indistinguishable from here: already known, not yet learnable,
    // or this really is the wrong merchant. `AssembleForSaleList` filters per buyer
    // (monster.kod:4855) and says nothing about any of them. So the failure is reported
    // as the ambiguity it is, with what the shop DID have, rather than as "not sold
    // here" — which would send somebody to check a merchant who was right all along.
    const learned = [], refused = [];
    for (const a of toLearn) {
      const opt = stock.find(i => nameOf(i).toLowerCase() === a.name.toLowerCase());
      if (!opt) {
        refused.push(`${a.name}: not offered here — either you already have it, cannot yet ` +
                     `learn it, or this is the wrong teacher (the shop had ${stock.length} thing(s))`);
        continue;
      }
      const cost = opt.cost ?? opt.price ?? a.price ?? 0;
      if (cost > money) { refused.push(`${a.name}: ${cost}sh, only ${money}sh`); continue; }
      // THE MERCHANT'S ANSWER IS THE ONLY EVIDENCE THERE IS, and this threw it away.
      //
      // The keeper's shop handler already returns the two halves that matter — `got`,
      // the items the wire actually moved, and `said`, the sentence the merchant spoke —
      // precisely because "the packet succeeded" has never meant "the purchase happened".
      // Discarding the response with .catch(() => null) meant a refusal that the server
      // EXPLAINED in words was reported downstream as "paid N and did not get it", which
      // sends a human to check a purse instead of reading the reason.
      //
      // A skill buy moves no item, so `got` is empty even on success and only `said` can
      // separate the two. Keep it and put it in the log either way.
      const bought = await call('shop', { agent: row.agent, seller: seller.id, buy_ids: [opt.id] })
                             .catch(e => ({ error: e.message }));
      if (bought?.error) refused.push(`${a.name}: buy failed — ${bought.error}`);
      const said = String(bought?.said ?? '').trim();
      money -= cost;
      learned.push({ ...a, cost, said: said || null });
    }

    // AND CHECK, BECAUSE THE BUY IS SILENT EITHER WAY. Nothing is sent when a skill is
    // added — `Buy` calls AddSkill and moves on (monster.kod:3862) — so "no error" has
    // never meant "learned", the same way it has never meant "equipped". A refresh
    // costs four requests and is worth them exactly once per character per errand: it
    // is the difference between a log that says what happened and one that says what
    // was attempted.
    for (const a of learned) {
      // POLL, DO NOT PEEK ONCE — and BELIEVE THE ANSWER WHEN IT IS STILL NO.
      //
      // A skill buy is silent on BOTH paths: monster.kod:3865 adds the skill and says
      // nothing, while every refusal ABOVE it speaks ("not selling", "too costly", "can't
      // give you"). So the skill list is the only evidence there is, and asking once races
      // it. Six polls over ~15s is the settle, not a verdict.
      //
      // BUT A "NO" THAT SURVIVES THE POLL IS REAL, AND IT HAS COST MONEY. Controlled
      // trial, 2026-09-07: Camilla stood with Rook, punch was in the live shop list at
      // 500, the buy went out well-formed, her purse went 2846 -> 2346 — exactly the
      // price — and punch never appeared, in the live list or the keeper's book, over
      // 100s of polling. Three OTHER characters holding punch that evening had been
      // bought by hand by the operator, which is what made this look like it worked.
      //
      // That combination should be impossible from the source: AddSkill and
      // SubtractNumber are in the SAME branch (monster.kod:3865-3877), so the money
      // cannot move unless AddSkill was called, and the only early return in AddSkill
      // that keeps the money is `HasSkill` — which PlayerCanLearn would have caught as
      // PLAYER_LEARN_ALREADY, so the shop would not have offered it. Either the running
      // server is not this source, or something in that chain differs. UNRESOLVED.
      //
      // Until it is: this failure is expensive, not cosmetic. Do not loop on it.
      let sure = false;
      for (let i = 0; i < 6 && !sure; i++) {
        await sleep(i === 0 ? 1200 : 2500);
        sure = (await knows(row.agent, a.name)) === true
            || (await knows(row.agent, a.name, { refresh: true })) === true;
      }
      log.push(sure ? `LEARNED ${a.name} @${a.cost}`
                    : `PAID ${a.cost} FOR ${a.name} AND DID NOT GET IT — the purse was ` +
                      'charged and the skill never arrived. This is a known unresolved ' +
                      'defect: do NOT retry in a loop, each attempt costs the price again' +
                      (a.said ? ` — the merchant said: "${a.said}"` : ' — the merchant said nothing, ' +
                       'which is what BOTH success and this failure look like'));
    }
    log.push(...refused);

    // WEAR IT. Buying without equipping is the same as not buying — and the shop
    // replies before the server has finished moving the goods, so an immediate read
    // reports the state from BEFORE the trade and every character comes back "still
    // missing armour" while carrying what it just paid for.
    if (WANT_GEAR) {
      await sleep(1500);
      const worn = await call('wear_best', { agent: row.agent }).catch(() => null);
      const held = await call('equip_best', { agent: row.agent }).catch(() => null);
      if (worn?.worn?.length) log.push('wearing ' + worn.worn.map(x => x.name).join(', '));
      if (held?.wielding) log.push('wielding ' + held.wielding);
    }

    items = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    const still = WANT_GEAR ? missingFor(items, wants)
      .filter(w => w.slot !== 'weapon' || mayBuyWeapons).map(w => w.what) : [];
    return `${who}: ${log.join(', ')}` + (still.length ? ` — STILL MISSING ${still.join(', ')}` : '');
  } catch (e) {
    // A shop call failing is a miss on this errand, not a crash of the whole sweep:
    // report it, put the orders back, and let the next run or the other owners retry.
    log.push(`FAILED mid-errand: ${e.message}`);
    return `${who}: ${log.join(', ')}`;
  }
};
  try {
    // One owner at a time. Wrap the whole errand in the claim/busy/free/yield protocol so
    // that a concurrent outfit run -- keeper-spawned, GOAP's send_to_town_for_gear, or a
    // hand run -- is refused the lease this one holds and backs off instead of walking
    // the same character to a second shop. GOAP reads the busy flag via `busyErrand` and
    // steps over a character we are driving, which is the guard this was decomposed for.
    const owned = await armOwnership(brokerDriver(null, call), {
      agent: row.agent, by: OWNER, kind: 'arm', label: `arming ${who}`,
      leaseMs: 120_000, heartbeatMs: 60_000, run: body,
    });
    if (!owned.ran) return `${who}: skipped -- ${owned.refused}`;
    return owned.result;
  } finally {
    // Put the orders back exactly as they were, including the strategy and the room
    // assignment -- an errand must not become a re-tasking.
    if (was?.running) {
      await call('autopilot', {
        agent: row.agent, action: 'start', mode: was.mode, hunt: was.policy?.hunt,
        strategy: was.policy?.strategy, flee_below: was.policy?.fleeBelow,
        rest_below: was.policy?.restBelow, max_carry: was.policy?.maxCarry,
        roam: was.policy?.roam, assigned_room: was.policy?.assignedRoom ?? null,
      }).catch(() => {});
    }
  }
}

// GUARDED ON BEING THE ENTRY POINT, so the pure helpers above can be imported and
// tested without the import itself walking the fleet across the world. m59-supervise
// carries the same guard for the same reason, and m59-broker is the counter-example:
// importing it takes the fleet lock and starts timers.
if (import.meta.filename === process.argv[1]) {

const f = await call('fleet', {});
let rows = (f.fleet || []).filter(r => r.in_game !== false);
if (ONLY && ONLY !== true) {
  const want = new Set(String(ONLY).split(',').map(x => x.trim()));
  rows = rows.filter(r => want.has(r.agent) || want.has(r.character));
}

// A CHARACTER CAN BE SPOKEN FOR, AND THIS ERRAND IS MINUTES LONG — so pulling one out
// of a loot run abandons the farmer waiting at the other end of it, silently. That is
// what m59-commitment.mjs is for and why the board greys those rows.
//
// BUT NOT EVERY COMMITMENT IS A JOURNEY, and treating them alike makes this tool
// useless: nearly the whole fleet is paired at any moment, so skipping pairs skipped
// eighteen of twenty-one characters and the errand became a no-op that reported
// success. m59-commitment.mjs already draws the line — its own ORDER puts `partner`
// last and calls it "a standing arrangement rather than a journey" — so that is the
// line used here rather than a new one invented in this file. An errand or a human
// pilot has another end that is WAITING; a pairing and a parked character do not, both
// halves of a pair are in this same sweep anyway, and the keeper's orders including the
// partner are restored verbatim when the trip ends.
const HAS_ANOTHER_END = new Set(['errand', 'driven']);
const skipped = [], suspended = [];
if (!(ONLY && ONLY !== true)) {
  const keep = [];
  for (const r of rows) {
    const c = r.committed;
    if (c && HAS_ANOTHER_END.has(c.kind) && !arg('committed', false))
      skipped.push(`${r.character || r.agent} (${c.label ?? c.kind})`);
    else { if (c) suspended.push(r.character || r.agent); keep.push(r); }
  }
  rows = keep;
}

console.log(`${LEARN.length ? `teaching ${LEARN.join(', ')} to` : 'outfitting'} ${rows.length} ` +
            `character(s)${DRY ? ' (dry run)' : ''}` +
            (AT ? ` at room ${AT}` : LEARN.length ? ' at the nearest teacher' : ' at the nearest smith'));
if (skipped.length)
  console.log(`  stepping over ${skipped.length} on an errand with somebody waiting: ` +
              `${skipped.join(', ')}  (--committed takes them anyway)`);
if (suspended.length)
  console.log(`  ${suspended.length} paired or parked, taken and put back afterwards: ${suspended.join(', ')}`);

// In small batches: each of these walks a character across the world, and running the
// whole fleet at once makes the broker's pacer the bottleneck for everything else.
const BATCH = 4;
for (let i = 0; i < rows.length; i += BATCH) {
  const res = await Promise.all(rows.slice(i, i + BATCH).map(r =>
    outfit(r).catch(e => `${r.character || r.agent}: FAILED ${e.message}`)));
  res.forEach(x => console.log('  ' + x));
}
process.exit(0);

}
