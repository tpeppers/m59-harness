#!/usr/bin/env node
// PRIVATE TRAVEL STRATEGIES: THE LOADER, WHICH IS SHARED. THE STRATEGIES ARE NOT.
//
//   node tools/m59-strategies.mjs              what this machine has, and whether it parses
//   node tools/m59-strategies.mjs --example    print the shape to start from
//
// `substrate/strategies/*.mjs` is gitignored and holds executable strategies this fleet
// runs. Everything else private in this repository is a NUMBER with its shape committed;
// this is a step further and hides the code, because a travel strategy is an instruction to
// a character that the keeper imports and runs. A file that parses is a file the fleet
// obeys, and one arriving from somebody else's afternoon should not be.
//
// So this file — the loader, the contract, and the refusals — is committed and tested, and
// `substrate/strategies.example.mjs` is the shape. The example lives BESIDE the directory
// and never inside it: `load()` enumerates every `.mjs` in there, so an example in there is
// a strategy nobody asked for. That mistake has already been made once in this repository
// with `substrate/loadouts/`.
//
// THE FOUR RULES ARE THE POLICY RULES, because a strategy is policy that happens to be code
// (docs/m59-policy.md argues each):
//
//   - SILENCE MEANS THE BEHAVIOUR THAT WAS ALREADY THERE. No strategies directory, or an
//     empty one, is a fleet that travels exactly as it did before. It is never an empty
//     policy and never paralysis.
//   - A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE. It is reported, loudly, by name and
//     with the error, and the others still load. Swallowing it would silently return the
//     fleet to default behaviour while the operator believed a strategy was running.
//   - AN UNUSABLE STRATEGY KEEPS THE COMMITTED BEHAVIOUR rather than unsetting it.
//   - AN UNRECOGNISED EXPORT IS REPORTED, never applied and never dropped, because a
//     setting that silently does nothing is how `purpose` stayed out of a schema for a year
//     with every keeper's audit switched off.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importWithAutoRestore } from './m59-substrate-archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const STRATEGY_DIR = join(HERE, '..', 'substrate', 'strategies');
export const EXAMPLE = join(HERE, '..', 'substrate', 'strategies.example.mjs');

// THE CONTRACT. A strategy is a module with a default export shaped like this. Anything
// else it exports is reported as unrecognised rather than ignored.
//
//   export default {
//     name: 'blink-escape',           // required, unique; how it appears in the ledger
//     kind: 'travel',                 // required; see KINDS below
//     enabled: false,                 // required, and FALSE is the honest default
//     // TRAVEL hooks --------------------------------------------------------------
//     // Asked when a walk has run out of ordinary answers. Return null to decline —
//     // declining is the common case and must stay cheap.
//     async whenStuck(ctx) { return null; },
//     // Asked before a crossing starts, for strategies that do not wait for trouble.
//     async beforeCrossing(ctx) { return null; },
//     // TOWN hooks ----------------------------------------------------------------
//     // Asked when a character is standing at a counter and something has to decide what
//     // to hand over. Return null to decline; return a plan to have it obeyed.
//     //   ctx = { loadout, items, equipped, room, merchant, purse, bulkFree, allies }
//     // The answer is m59-townstop.planTownStop's shape:
//     //   { sell, buy, give, keep_fragments, withheld, conflicts, spare_before, ... }
//     //
//     // `allies` is who ELSE is standing here and what they are short of, shaped by
//     // m59-townstop.alliesInRoom: [{ agent, character, wants: [{item, short, kind}] }],
//     // neediest first. It is the ctx's only field about somebody other than the subject,
//     // and it was added on 2026-09-17 for `restock-allies` — a stance that hands a
//     // fleetmate the reagents it is short of instead of selling them at a spread and
//     // letting it buy them back at a worse one. A strategy that ignores it behaves exactly
//     // as it did before, which is the first policy rule.
//     //
//     // `give` is the leg that serves it: [{ item, to, amount, from }]. `planTownStop`
//     // subtracts a give from the `sell` amounts it draws on, so a plan can never promise
//     // the same units to a merchant and a fleetmate — assert it with
//     // `neverSellsWhatItGives`, which is arithmetic over `spare_before` rather than a name
//     // match, because a PARTIAL give is correct and costs nothing.
//     async atTownStop(ctx) { return null; },
//     // Asked by every keeper about CHALICE FARMING — a free Rescue home for each town trip,
//     // handed out by one named holder at a refill-room station (tools/m59-chalice.mjs).
//     //   ctx = { agent, character }
//     // Return the configuration, `normalizeChalice`'s shape, or null for "not here". The
//     // names of the holder and alternate are why this lives in a private strategy.
//     async chalice(ctx) { return null; },
//     // COMBAT hooks --------------------------------------------------------------
//     // Asked on every tick of a PvP fight in which the character carries a volley wand:
//     // which wand to zap, if any, and whether to hold melee. The harness still approaches
//     // and enforces sight/facing/cooldown at dispatch. Return null
//     // to decline and the built-in volley runs. ctx and the answer's shape are documented
//     // beside the built-in, m59-pvp-gear.mjs chooseWandVolley. Asked ten times a second, so
//     // it must be cheap: no I/O, no waiting.
//     async pvpWand(ctx) { return null; },
//     // Asked on every tick of a PvP or war fight, BEFORE the gear, the volley and the swing:
//     // a spell to open with at the target the fight already chose -- { cast: '<spell>' } --,
//     // { wait: true } to send nothing and not fall through, or null to decline. It never
//     // chooses a target. ctx and the rules are beside CombatMode.pvpOpener. Cheap, like pvpWand.
//     async pvpOpener(ctx) { return null; },
//     // Opt-in fallback queue, consulted only when the primary attack is
//     // infeasible and its shared timer is clear. Inspection is asynchronous.
//     // ctx.personal_threat distinguishes joining a fight from being targeted.
//     // Return { queue: [{use: carriedPotionId}], interval_ms: 1000..60000 }
//     // or null. Names/effect preference belong in the private module.
//     async pvpFallback(ctx) { return null; },
//     // Independent consumables with no shared attack timer. Current closed
//     // action: a healing wand applied to self or a freshly observed fleetmate.
//     // ctx adds items:[{id,name,kind}], targets:[{id,name,self,health,at}].
//     // Return {queue:[{apply:wandId,to:playerId,below:0..1,min_missing:2+}],
//     // interval_ms:1000..60000}, or null. Limits are rechecked at dispatch.
//     async pvpSupport(ctx) { return null; },
//     // Stock-aware self/ally healing, in PvP and ordinary farming alike.
//     // healingWand(ctx) sees pvp/farming, base_below, inspected_item and each
//     // item's condition (charged/empty/unknown) with inspected_at. Only a
//     // recent positive LOOK counts as charged; a used wand becomes unknown.
//     // Same support queue shape; inspect:true permits a bounded healthy LOOK
//     // to establish stock. This hook must be synchronous at paced dispatch,
//     // where current stock and target HP are rechecked against its answer.
//     healingWand(ctx) { return null; },
//     // Asked every 250 ms of a fight with a PLAYER (PvP, war or warband): how much to STRETCH this
//     // character's own attack timer, voluntarily. { factor: 1..4, why? } multiplies the cooldown
//     // stamped after every swing, zap and targeted cast (2 = attack at half speed); { released: true }
//     // ends the stretch for the rest of this fight and the hook is not asked again until the fight
//     // ends. null or factor 1 is full speed. { factor, after: 'hit' } stretches only a blow the server
//     // confirms did damage, with the hook asked again the instant that hit lands; a miss leaves the plain
//     // timer. ctx = { now, character, room, target: { name, health },
//     // me: { health_pct }, enemies_here, allies_here, engaged, attackers_on_target, hitters_on_target,
//     // fight: { started_at, low_groan, ally_low } }: `engaged` and `attackers_on_target` are the fleet's
//     // distinct attackers (us included) read from the shared m59-pvp-focus.mjs book, `hitters_on_target`
//     // the distinct ones whose damage landed on the target in the last 4 s (us only if we did); `low_groan` is the
//     // first band-4 pain sound (25% or less) any of us heard in this room since the fight began;
//     // `ally_low` a fleet-mate here at 25% or less. Synchronous and cheap: no I/O, no waiting.
//     pvpPace(ctx) { return null; },
//     // Asked by a keeper CONSIDERING a town stop (at most once a minute) and again, unthrottled,
//     // as one OPENS (ctx.opening = { purpose, trigger, to }). It may start a trip now and/or add
//     // "while you're in town" favors -- e.g. when two casters run low, the next shopper goes and
//     // brings their reagents back. Shapes and limits: m59-town-favors.mjs.
//     //   ctx = { agent, character, room, assigned_room, purse, opening, held, favors }
//     //   answer = { start?: { town, why }, favors?: [{ item, amount, deliver_to, deliver_room?,
//     //              source?, shop_room?, key? }] }  -- or null to decline.
//     async townTrip(ctx) { return null; },
//     // Asked by a FARMING keeper every pass, on the wall before a pull, and before the first swing of a
//     // fight at the wall: a self-buff to cast, whether to go back to the safe spot, whether to engage at
//     // all, and whether to log off for a few seconds. ctx and the answer's closed shape are beside
//     // Autopilot.farmBuffContext. Cheap: no I/O, no waiting.
//     async farmBuff(ctx) { return null; },
//     // CASTING hooks (m59-castrite.mjs) -------------------------------------------
//     // Asked before every cast routed through withCastRite: gear to swap on for this spell, and
//     // whether to put it back after the trance, after a linger, or never. ctx and the answer's
//     // closed shape are documented at the top of m59-castrite.mjs.
//     async castRite(ctx) { return null; },
//     // Asked on every room change and every few seconds of a keeper pass while nothing is being
//     // cast: gear steps to fix what is worn now, and names the keeper must not wear by itself.
//     async idleGear(ctx) { return null; },
//     // LOOT hooks (m59-curse-cycle.mjs) ----------------------------------------------
//     // Asked by every keeper, at most once a minute, about the CURSE CYCLE: whether this
//     // character may pick up unidentified rings and break a curse on itself with remove curse,
//     // and which names it keeps and carries to the guild hall. Cheap: no I/O, no waiting.
//     //   ctx = { agent, character, spells, karma, emeralds, mana, room, guild_wants }
//     //   answer = { pickup?, keep?, hall?, reserve?, karma_min?, mana_min?, hall_min?, why? }
//     // Shapes and refusals: normalizeCurseCycle. null for "not this character".
//     async curseCycle(ctx) { return null; },
//     // CONVOY strategies use beforeCrossing too, but are asked a group question — "should
//     // we all go now" rather than "how do I get through". See substrate/strategies.example.mjs.
//   }
export const REQUIRED = ['name', 'kind', 'enabled'];
// cooperativeLogoff(ctx): explicit private opt-in for shared offline distraction
// requests. Policy and settings stay private; see docs/m59-cooperative-logoff.md.
// rescueTravel(ctx): {enabled, double, guildName, guildHall, blocked?, confine?, fallbackMs?}.
// Selection only; the executor validates resources, guild, landings and movement ownership.
// cooperativeCombat: configure once with {decide(ctx)}; the synchronous decision
// receives fresh same-roster observations and returns a checked target/hold choice.
// It supplements individual farming assignments; protected faculties remain central.
export const HOOKS = ['cooperativeCombat', 'cooperativeLogoff', 'rescueTravel', 'whenStuck', 'beforeCrossing', 'atTownStop', 'chalice', 'pvpWand', 'pvpOpener', 'pvpFallback', 'pvpSupport', 'healingWand', 'pvpPace', 'townTrip', 'wandDuty', 'farmBuff', 'castRite', 'idleGear', 'curseCycle'];
// 'town' was added when the sell/buy filter moved out of m59-sellrun.mjs's private copy.
// A KIND IS NOT A HOOK: the kind says what a strategy is about and the hook says when it is
// asked, and keeping them separate is what lets a town strategy be listed, enabled and
// audited by the same loader without the travel path ever calling it.
// 'convoy' is travel too, but it is about a GROUP and it is asked on a different question:
// not 'how do I get through' but 'should we all go now'. Keeping it a separate kind is what
// lets a convoy strategy be listed, enabled and audited without the solo mover consulting it.
// 'combat' (2026-10-05) is asked inside a fight, by CombatMode, about the wand volley.
// 'casting' (2026-10-16) is asked around a cast and about idle gear, by m59-castrite.mjs.
// 'loot' (2026-10-19) is asked by the keeper about which loot it may take and keep (curseCycle).
export const KINDS = ['cooperative', 'travel', 'town', 'convoy', 'combat', 'casting', 'loot'];
const KNOWN = new Set([...REQUIRED, ...HOOKS, 'describe', 'settings']);

/**
 * Everything this machine has, with the ones that could not be loaded named rather than
 * dropped. Never throws: a broken strategy must not take the keeper down with it.
 */
export async function load({ dir = STRATEGY_DIR, log = m => console.error(m) } = {}) {
  const out = { dir, strategies: [], problems: [], restored: [], present: false };
  try { if (!existsSync(dir) || !statSync(dir).isDirectory()) return out; }
  catch { return out; }
  out.present = true;

  // A LEADING UNDERSCORE IS A HELPER, NOT A STRATEGY. The recorder that measures
  // `blink_race_to_<exit>` has to live in this directory -- it is as private as the strategy
  // that reads it -- but it answers no hook, so enumerating it would report a problem every
  // load for a file that is working perfectly. `_name.mjs` is imported by the strategies
  // that want it and never loaded as one.
  let names = [];
  try {
    names = readdirSync(dir)
      .filter(n => n.endsWith('.mjs') && !n.startsWith('_'))
      .sort();
  }
  catch (e) { out.problems.push({ file: dir, why: 'could not be read: ' + e.message }); return out; }

  for (const name of names) {
    const path = join(dir, name);
    let mod;
    // AN ARCHIVED IMPORT IS PUT BACK, NOT READ AS "NO STRATEGY". 2026-10-21: chalice-farming.mjs
    // imported ../production-robin-guild-posture.mjs after a bare `mv` archived it; this load runs
    // once per keeper, so every keeper's chalice config came back null and read as "off", and the
    // problem below was seen by nobody. importWithAutoRestore brings the module (and its other
    // archived imports) back from substrate/scratch/archive-*/ and retries once; m59-substrate-archive.mjs.
    try {
      const r = await importWithAutoRestore(pathToFileURL(resolve(path)).href, { entry: resolve(path), log });
      mod = r.mod;
      if (r.restored) out.restored.push({ file: name, summary: r.restored.summary });
    }
    catch (e) {
      // NAMED, NOT SWALLOWED. See the header: a file that will not parse is not an empty
      // file, and reporting it as one returns the fleet to default behaviour in silence.
      // And LOUD: the consumers of `load` mostly read `strategies`, so a problem only in the
      // list is a problem nobody hears.
      out.problems.push({ file: name, why: 'did not load: ' + e.message });
      log(`[strategies] ${name} DID NOT LOAD -- every hook it answers is OFF in this process: ${e.message}`);
      continue;
    }
    const s = mod?.default;
    if (!s || typeof s !== 'object') {
      out.problems.push({ file: name, why: 'has no default export shaped like a strategy' });
      continue;
    }
    const missing = REQUIRED.filter(k => s[k] === undefined);
    if (missing.length) {
      out.problems.push({ file: name, why: 'is missing ' + missing.join(', ') });
      continue;
    }
    if (!KINDS.includes(s.kind)) {
      out.problems.push({ file: name, why: `kind "${s.kind}" is not one of ${KINDS.join(', ')}` });
      continue;
    }
    if (out.strategies.some(x => x.name === s.name)) {
      out.problems.push({ file: name, why: `another strategy is already called "${s.name}"` });
      continue;
    }
    const hooks = HOOKS.filter(h => typeof s[h] === 'function');
    if (!hooks.length) {
      out.problems.push({ file: name, why: 'declares no hook — one of ' + HOOKS.join(', ') });
      continue;
    }
    // REPORTED, NEVER APPLIED AND NEVER DROPPED.
    const unknown = Object.keys(s).filter(k => !KNOWN.has(k));
    if (unknown.length)
      out.problems.push({ file: name, why: 'exports nothing that reads: ' + unknown.join(', '),
                          unrecognised: true });
    out.strategies.push({ ...s, file: name, hooks, unrecognised: unknown });
  }
  return out;
}

/** The enabled ones that answer a given hook, in load order. */
export function activeFor(loaded, hook) {
  return (loaded?.strategies ?? [])
    .filter(s => s.enabled && typeof s[hook] === 'function');
}

/**
 * Ask each enabled strategy in turn and take the FIRST that offers something.
 *
 * A strategy that throws is reported and skipped, never fatal — see the header. It is asked
 * on a stuck walk, which is already the unhappy path, and an exception there must not turn a
 * slow crossing into a dead character.
 */
export async function firstAnswer(loaded, hook, ctx, { onError = null } = {}) {
  for (const s of activeFor(loaded, hook)) {
    try {
      const answer = await s[hook](ctx);
      if (answer) return { strategy: s.name, answer };
    } catch (e) {
      onError?.({ strategy: s.name, why: e.message });
    }
  }
  return null;
}

// ------------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-strategies.mjs')) {
  if (process.argv.includes('--example')) {
    if (!existsSync(EXAMPLE)) { console.error('substrate/strategies.example.mjs is missing'); process.exit(2); }
    const { readFileSync } = await import('node:fs');
    process.stdout.write(readFileSync(EXAMPLE, 'utf8'));
    process.exit(0);
  }
  const loaded = await load();
  if (!loaded.present) {
    console.log(`\nno ${STRATEGY_DIR}\n`);
    console.log('  That is not an error and not an empty policy — the fleet travels exactly as');
    console.log('  it did before. To add one: mkdir substrate/strategies, then start from');
    console.log('  node tools/m59-strategies.mjs --example\n');
    process.exit(0);
  }
  console.log(`\n${loaded.strategies.length} strategy(s) in ${loaded.dir}\n`);
  for (const s of loaded.strategies)
    console.log(`  ${s.enabled ? 'ON ' : 'off'}  ${String(s.name).padEnd(18)} ${s.kind.padEnd(8)} ` +
                `${s.hooks.join(', ')}${s.describe ? '  — ' + s.describe : ''}`);
  if (loaded.problems.length) {
    console.log('\n  problems — reported rather than dropped:');
    for (const p of loaded.problems) console.log(`    ${p.file}: ${p.why}`);
  }
  console.log('');
}
