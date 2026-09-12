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
import { callTool, fleetRoster } from './m59-describe.mjs';
import { ITEM_RARITY, rarityName, isUnidentified } from './m59-items.mjs';

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
  } else {
    console.log(`m59-reveal.mjs — the fleet's identification service

  sweep                      every unidentified item in the fleet and who holds it
  status  --agent <a>        one caster: teeth, mana, and what is in reach
  run     --agent <a>        reveal everything unidentified in that caster's pack
          --dry              plan only
          --max <n>          stop after n
          --identify         use identify (1 tooth, transient) instead of reveal (3, permanent)

Teeth come from buy-orc-teeth (say "orc teeth" to Paddock in 52 — his shelf does not list
them until you ask). Grade 100 is the whole filter; see the header for why.`);
  }
}
