#!/usr/bin/env node
// A BOSS RAID, AS A TACTIC RATHER THAN AS AN AFTERNOON.
//
//   node tools/m59-bossraid.mjs --target Ghost --room 40 --via 38,40
//   node tools/m59-bossraid.mjs --target Ghost --room 40 --via 38,40 --channel guild --commit
//   node tools/m59-bossraid.mjs --target Ghost --room 40 --plan        say what it would do
//
// ============================================================================
// THIS ONE RUNS ON PROD. THAT IS THE WHOLE DESIGN CONSTRAINT.
// ============================================================================
//
// `m59-simulate.mjs` is the laboratory version and is loopback-only on purpose: it
// teleports bodies over the maintenance socket and strips every rung of the survival
// ladder, and neither of those is a thing to do to a live fleet. This one therefore uses
// NOTHING but broker tools — travel, supply, cast, equip, attack, say. No maintenance
// socket, no teleport, no policy stripping. What it loses is the ability to set a fight up
// instantly; what it buys is that the tactic you rehearse on the test server is the same
// code that runs on the real one, which is the only way a rehearsal means anything.
//
// ============================================================================
// WHY THE PREPARATION IS THE TACTIC
// ============================================================================
//
// The Ghost of Far'Nohl carries `[90, ATCK_WEAP_NONMAGIC]` and `[-50, ATCK_WEAP_MAGIC]`
// (ghost.kod:83). A mundane mace lands 10% of its damage on it; an enchanted one lands
// 150%. That is a FIFTEENFOLD difference and it dwarfs anything else a raid can decide —
// more bodies, better positioning, longer fights are all noise beside it. Most bosses in
// this game carry a resistance table of the same shape, so the general rule is: read the
// table, and spend the minutes before the fight making the weapons match it.
//
// `enchant weapon` (enchwp.kod) costs 17 mana, 3 elderberry and 1 orc tooth, and
// `IsTargetInRange` accepts a weapon whose owner is the CASTER or the room — never one in
// somebody else's pack. So the weapons have to physically change hands, which is four
// steps per weapon and exactly the kind of bookkeeping a person gets wrong at 02:00:
//
//     reagents -> enchanter, weapon -> enchanter, cast, weapon -> back, re-equip
//
// Each of those is announced, because a raid that goes wrong goes wrong in the middle and
// the transcript is the only record of where. `--channel guild` sends it to the guild
// instead of the room: on prod the fleet is in a guild and the room is full of strangers;
// on a test server there is no guild, so `say` is the default.
//
// ============================================================================
// WHAT IT REFUSES TO DO
// ============================================================================
//
//   * it does not act at all without `--commit`. The default prints the plan.
//   * it does not disarm anybody's survival ladder. A raid is not an errand; the keeper
//     keeps mortality and survival exactly as `docs/m59-boundary.md` requires, so a
//     character losing a fight still runs from it. If you want a fight to the death, that
//     is `m59-simulate.mjs` on a server you can afford it on.
//   * it takes the run lock, marks every raider `busy`, and leases work/movement/economy
//     off each keeper for the duration, freeing all of it in a finally and on signals.
//   * it never hands over a CURSED weapon (a cursed weapon cannot be put down: wielding
//     one is the only irreversible mistake in this game) and never hands over the last
//     weapon of a character that would then be unarmed with no way to get it back.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeRunLock } from './m59-runlock.mjs';
import { holdKeeper } from './m59-fleetscript.mjs';
import { classify, summarise, nextStep } from './m59-simulate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

// What `enchant weapon` costs, from the spell itself (enchwp.kod:50,63-65). Named here so
// a raid that cannot afford it says so with numbers rather than failing at the cast.
export const ENCHANT = Object.freeze({
  spell: 'enchant weapon', mana: 17,
  reagents: Object.freeze([{ name: 'elderberry', each: 3 }, { name: 'orc tooth', each: 1 }]),
});

let SEQ = 0;
function makeRpc(url) {
  return (name, args = {}, ms = 60_000) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++SEQ, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(ms) })
      .then(r => r.json())
      .then(j => (j.result?.isError ? { error: j.result.content[0].text }
        : (() => { try { return JSON.parse(j.result.content[0].text); } catch { return j.result?.content?.[0]?.text ?? j; } })()))
      .catch(e => ({ error: e.message }));
}

/** Everything the raid needs to know about one character, in one read. */
export async function survey(rpc, agent) {
  const [st, inv, ab] = await Promise.all([
    rpc('status', { agent, brief: true }, 40_000),
    rpc('inventory', { agent }, 40_000),
    rpc('abilities', { agent }, 40_000),
  ]);
  const items = inv?.items ?? [];
  const count = re => items.filter(i => re.test(i.name || '')).reduce((n, i) => n + (i.amount || 1), 0);
  const spells = ab?.spells ?? [];
  const enchant = spells.find(s => /enchant weapon/i.test(s.name || ''));
  // A weapon is what the character can actually swing. `equipment` is the only answer to
  // what is WORN or WIELDED — the pack is a different list and says nothing about it.
  const wielded = (st?.equipment ?? []).find(e => !/shield|helm|armor|armour/i.test(String(e)));
  return {
    agent,
    character: st?.character ?? agent,
    hp: st?.hp ? `${st.hp.value}/${st.hp.max}` : '?',
    mana: st?.mana?.value ?? null,
    room: st?.room?.num ?? st?.where?.num ?? null,
    wielded: wielded ?? null,
    items,
    elderberry: count(/elderberry/i),
    orcTooth: count(/orc tooth/i),
    canEnchant: enchant ? (enchant.ability ?? 0) : null,
  };
}

/** Who casts, who is supplied, and whether the reagents exist at all. */
export function planEnchantment(rows, { casters = null } = {}) {
  const enchanters = rows.filter(r => r.canEnchant !== null)
    .sort((a, b) => (b.canEnchant ?? 0) - (a.canEnchant ?? 0))
    .slice(0, casters ?? 99);
  const pool = {
    elderberry: rows.reduce((n, r) => n + r.elderberry, 0),
    orcTooth: rows.reduce((n, r) => n + r.orcTooth, 0),
  };
  const armed = rows.filter(r => r.wielded);
  // One cast per weapon, and the binding constraint is whichever runs out first: reagents,
  // or the mana the enchanters are holding. Both are reported because they are fixed by
  // different errands — a shopping trip and a rest.
  const byReagent = Math.min(Math.floor(pool.elderberry / 3), pool.orcTooth);
  const byMana = enchanters.reduce((n, e) => n + Math.floor((e.mana ?? 0) / ENCHANT.mana), 0);
  return {
    enchanters, pool, armed,
    casts: Math.min(byReagent, byMana),
    limitedBy: byReagent <= byMana ? 'reagents' : 'mana',
    byReagent, byMana,
    short: Math.max(0, armed.length - Math.min(byReagent, byMana)),
  };
}

// ---------------------------------------------------------------- the run
async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const brokerUrl = arg('--broker', process.env.M59_CONTROL_URL || 'http://127.0.0.1:8971/');
  const fleet = arg('--fleet', process.env.M59_FLEET || 'shadow-ab');
  const room = Number(arg('--room', 40));
  const targetWanted = arg('--target', 'Ghost');
  const via = (arg('--via') ?? '').split(',').map(x => Number(x.trim())).filter(Number.isFinite);
  const channel = arg('--channel', 'say');              // `guild` on prod, `say` on a test server
  const commit = argv.includes('--commit');
  const minutes = Number(arg('--minutes', 12));
  const reach = Number(arg('--reach', 1.45));
  const rpc = makeRpc(brokerUrl);

  if (!['say', 'guild', 'yell', 'emote'].includes(channel)) {
    console.error(`--channel must be say, guild, yell or emote (got "${channel}")`); process.exit(2);
  }

  const health = await (await fetch(new URL('/health', brokerUrl))).json();
  const characters = health.session_characters ?? {};
  const agents = Object.keys(characters).sort();
  if (!agents.length) { console.error('that broker is holding nobody'); process.exit(1); }
  console.log(`${agents.length} raider(s) on ${health.fleet} — narrating on "${channel}"`);

  // ---- 1. SURVEY. Read the whole fleet before saying a word about the plan.
  const rows = [];
  for (const a of agents) rows.push(await survey(rpc, a));
  const plan = planEnchantment(rows);
  console.log(`\nARMED        ${plan.armed.length}/${rows.length}` +
    `   ${plan.armed.map(r => `${r.character}:${r.wielded}`).slice(0, 6).join(' ')}` +
    (plan.armed.length > 6 ? ` +${plan.armed.length - 6}` : ''));
  console.log(`ENCHANTERS   ${plan.enchanters.length}` +
    `   ${plan.enchanters.map(e => `${e.character} ${e.canEnchant}% (${e.mana} mana)`).join(', ') || '(nobody)'}`);
  console.log(`REAGENTS     ${plan.pool.elderberry} elderberry, ${plan.pool.orcTooth} orc tooth` +
    `  -> ${plan.byReagent} cast(s); mana allows ${plan.byMana}`);
  console.log(`ENCHANTS     ${plan.casts} of ${plan.armed.length} weapon(s), limited by ${plan.limitedBy}` +
    (plan.short ? `  — ${plan.short} raider(s) go in with a mundane weapon` : ''));
  if (via.length) console.log(`ROUTE        ${via.join(' -> ')}, engaging "${targetWanted}" in room ${room}`);

  if (!commit) {
    console.log('\n--plan only. Re-run with --commit to raid.');
    if (plan.short) console.log(`Short ${plan.short} enchant(s): 3 elderberry + 1 orc tooth per weapon.`);
    process.exit(0);
  }

  // ---- THE REAGENT GATE.
  //
  // A raid that sets out without the enchantments is a DIFFERENT raid — against a boss with
  // `[90, ATCK_WEAP_NONMAGIC]` it is the one where the fleet does a tenth of its damage —
  // and that is a decision for a person, not a default. So a shortfall stops the run and
  // says so on the raid channel, where the operator is actually looking, rather than only
  // in a terminal nobody is watching.
  //
  // It exits NON-ZERO and changes nothing, so the remedy is the obvious one: buy or conjure
  // the reagents and run the same command again. `--anyway` is the override for going in
  // regardless, and it is deliberately a separate word from `--commit`: "I mean to raid"
  // and "I mean to raid underequipped" are different intentions and must look different on
  // the command line.
  if (plan.short && !argv.includes('--anyway')) {
    const short = `Raid held: ${plan.short} of ${plan.armed.length} weapons cannot be enchanted ` +
      `(${plan.pool.elderberry} elderberry, ${plan.pool.orcTooth} orc tooth; need ` +
      `${plan.armed.length * 3} and ${plan.armed.length}). Limited by ${plan.limitedBy}.`;
    console.error(`\n${short}`);
    // Said by whoever would have led it, on the channel the raid uses, so the hold is
    // visible to anyone watching the guild rather than only here.
    const lead0 = plan.enchanters[0] ?? rows[0];
    const rpcSay = (agent, text) => rpc('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000);
    await rpcSay(lead0.agent, short).catch(() => {});
    await rpcSay(lead0.agent, 'Holding here. Bring reagents and give the order again.').catch(() => {});
    console.error('Nothing was changed. Get the reagents and re-run the same command,');
    console.error('or pass --anyway to go in underequipped and do the best we can.');
    process.exit(4);
  }
  if (plan.short) console.log(`\nGOING IN UNDEREQUIPPED — ${plan.short} mundane weapon(s), --anyway was passed.`);

  // ---- THE GUARANTEES. One driver, bodies held, faculties leased, all of it given back.
  const lock = takeRunLock(fleet, { label: `bossraid ${targetWanted} [${agents.length}]`,
                                    force: argv.includes('--force') });
  if (!lock.ok) {
    console.error(`REFUSING — fleet "${fleet}" is already being driven by pid ${lock.holder?.pid}` +
                  ` (${lock.holder?.label ?? '?'})`);
    process.exit(3);
  }
  const ctx = { log: (...a) => console.log(now(), ...a), name: 'bossraid' };
  const holds = new Map();
  let releasing = false;
  const release = async () => {
    if (releasing) return; releasing = true;
    for (const [, h] of holds) { await h.cancelJourney?.('the raid ended').catch(() => {}); await h.release?.().catch(() => {}); }
    await Promise.all(agents.map(a => rpc('autopilot', { agent: a, action: 'free' }).catch(() => {})));
    try { lock.release?.(); } catch {}
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { release().finally(() => process.exit(130)); });

  const transcript = [];
  const say = async (agent, text) => {
    transcript.push({ at: Date.now(), agent, text });
    // Truncated to one send: the server takes a single string and a raid line that gets
    // cut in half is worse than a short one.
    await rpc('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000);
  };

  try {
    for (const a of agents) {
      await rpc('autopilot', { agent: a, action: 'busy', kind: 'bossraid', label: targetWanted }).catch(() => {});
      holds.set(a, await holdKeeper(ctx, a, fleet));
    }

    const lead = plan.enchanters[0] ?? rows[0];
    await say(lead.agent, `Raid on ${targetWanted}. ${plan.armed.length} armed, ` +
      `${plan.casts} enchant(s) available, limited by ${plan.limitedBy}.`);
    if (plan.short)
      await say(lead.agent, `${plan.short} of us go in with a mundane weapon. Expect it to be slow.`);

    // ---- 2. REAGENTS TO THE ENCHANTERS.
    //
    // `supply` rather than `trade`: trade lies in both directions, and supply verifies the
    // receiver actually holds the goods afterwards. One call moves one reagent kind.
    for (const e of plan.enchanters) {
      for (const { name, each } of ENCHANT.reagents) {
        const key = name === 'orc tooth' ? 'orcTooth' : 'elderberry';
        const want = each * Math.max(1, Math.floor((e.mana ?? 0) / ENCHANT.mana));
        if ((e[key] ?? 0) >= want) continue;
        const donor = rows.find(r => r.agent !== e.agent && (r[key] ?? 0) > 0);
        if (!donor) {
          await say(e.agent, `No ${name} anywhere in the raid — I can cast ${Math.floor((e[key] ?? 0) / each)} more.`);
          continue;
        }
        await say(donor.agent, `${e.character}, sending you ${want - (e[key] ?? 0)} ${name} for the enchanting.`);
        const r = await rpc('supply', { from: donor.agent, to: e.agent, what: name,
                                        amount: want - (e[key] ?? 0) }, 400_000);
        await say(e.agent, r?.error ? `Did not get the ${name}: ${String(r.error).slice(0, 80)}`
                                    : `Have the ${name}, thank you.`);
      }
    }

    // ---- 3. WEAPONS OVER, ENCHANTED, AND BACK.
    let done = 0;
    for (const owner of plan.armed) {
      if (done >= plan.casts) { await say(owner.agent, `No reagents left — going in with my ${owner.wielded}.`); continue; }
      const e = plan.enchanters.find(x => (x.mana ?? 0) >= ENCHANT.mana) ?? plan.enchanters[0];
      if (!e) break;
      if (e.agent === owner.agent) {
        await say(e.agent, `Enchanting my own ${owner.wielded}.`);
      } else {
        await say(owner.agent, `${e.character}, my ${owner.wielded} — enchant it please.`);
        const gave = await rpc('supply', { from: owner.agent, to: e.agent, what: owner.wielded, amount: 1 }, 400_000);
        if (gave?.error) { await say(owner.agent, `Could not hand it over: ${String(gave.error).slice(0, 80)}`); continue; }
      }
      const cast = await rpc('cast', { agent: e.agent, spell: ENCHANT.spell, target: owner.wielded }, 90_000);
      const worked = !cast?.error;
      await say(e.agent, worked ? `${owner.character}, your ${owner.wielded} is enchanted.`
                                : `The enchantment failed on ${owner.character}'s ${owner.wielded}: ` +
                                  String(cast.error).slice(0, 70));
      if (worked) done++;
      if (e.agent !== owner.agent) {
        const back = await rpc('supply', { from: e.agent, to: owner.agent, what: owner.wielded, amount: 1 }, 400_000);
        if (back?.error) await say(e.agent, `I still have ${owner.character}'s ${owner.wielded}!`);
        else { await rpc('equip_best', { agent: owner.agent }, 60_000); await say(owner.agent, `Got it back, wielding.`); }
      }
      e.mana = Math.max(0, (e.mana ?? 0) - ENCHANT.mana);
    }
    await say(lead.agent, `${done} weapon(s) enchanted. Moving out.`);

    // ---- 4. THE APPROACH.
    for (const hop of via) {
      await say(lead.agent, `Everyone to room ${hop}.`);
      const started = Date.now();
      await Promise.all(agents.map(a => rpc('travel', { agent: a, to: hop, background: true }, 90_000)));
      const deadline = started + Number(arg('--hop-minutes', 8)) * 60_000;
      let there = [];
      while (Date.now() < deadline) {
        const states = await Promise.all(agents.map(a => rpc('status', { agent: a, brief: true }, 30_000)));
        there = agents.filter((a, i) => (states[i]?.room?.num ?? states[i]?.where?.num) === hop);
        if (there.length === agents.length) break;
        await sleep(6000);
      }
      console.log(`${now()} room ${hop}: ${there.length}/${agents.length} in ${Math.round((Date.now() - started) / 1000)}s`);
      await say(lead.agent, `${there.length} of ${agents.length} made it to ${hop}.`);
    }

    // ---- 5. ENGAGE. Swing only from an ADJACENT square, because a monster's reach is not
    // a player's and a mace at 2.2 squares comes back "too far away to hit".
    //
    // BUT A SQUARE IS NOT A SLOT. Operator, 2026-09-11: two to four characters fit in one
    // coarse square depending on how well they squeeze, so the eight squares touching a
    // boss are not eight attackers — they are room for most of a raid. The queue this used
    // to predict does not exist, and nothing here reserves a square per raider: everyone
    // in reach swings every round, and the ones out of reach close on their own. Counting
    // adjacent SQUARES and calling it the width of the fight is the mistake.
    await say(lead.agent, `Target is ${targetWanted}. Surround it and hit it.`);
    const state = {
      room, roomName: `room ${room}`, target: { name: targetWanted }, characters,
      levels: {}, log: Object.fromEntries(agents.map(a => [a, []])),
      deaths: new Map(), started: Date.now(), ended: 0, won: false, verdict: '',
      peakInReach: 0, characters_count: agents.length, arrivals: [],
    };
    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() < deadline) {
      const looks = await Promise.all(agents.map(a => rpc('look', { agent: a }, 40_000)));
      let seen = null;
      const here = [];
      agents.forEach((a, i) => {
        const l = looks[i];
        if (!l || l.error) return;
        const objs = l.objects ?? l.room?.objects ?? [];
        const t = objs.find(o => new RegExp(targetWanted, 'i').test(o.name || ''));
        if (t) { seen = t; here.push({ agent: a, dist: t.distance ?? 99 }); }
      });
      if (!seen) { state.verdict = `${targetWanted} is not in sight`; state.won = true; break; }
      const inReach = here.filter(h => h.dist <= reach);
      state.peakInReach = Math.max(state.peakInReach, inReach.length);
      const swings = await Promise.all(inReach.map(h =>
        rpc('attack', { agent: h.agent, target: seen.id, swings: 2 }, 40_000).then(r => [h.agent, r])));
      for (const [a, r] of swings) for (const msg of r?.messages ?? []) state.log[a].push({ at: Date.now(), text: msg });
      // Anyone not in reach walks in; `approach` is broken on this broker, so it is a
      // one-square walk toward the target on the mover's own rule.
      for (const h of here.filter(x => x.dist > reach))
        rpc('fight', { agent: h.agent, target: targetWanted, rounds: 2, disengage_at: 0.35, loot: false }, 90_000).catch(() => {});
      await sleep(1200);
    }
    if (!state.verdict) state.verdict = 'the time limit ran out';
    state.ended = Date.now();

    // ---- 6. REPORT, and the transcript is part of it.
    const sum = summarise(state);
    const t = sum.total;
    console.log(`\n=== ${agents.length} v ${targetWanted} ===`);
    console.log(`${state.won ? 'TARGET DOWN' : 'NO KILL'} — ${state.verdict}   ${Math.round((state.ended - state.started) / 1000)}s`);
    console.log(`enchanted    ${done}/${plan.armed.length}`);
    console.log(`fleet swings ${t.swings} (${t.hits} landed), incoming ${t.incoming_target} from the target, ${t.incoming_other} from the room`);
    console.log(`most in reach ${state.peakInReach} of ${agents.length}`);
    const out = path.join(REPO, 'substrate', 'raids',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${targetWanted.replace(/\W+/g, '')}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ plan: { ...plan, enchanters: plan.enchanters.map(e => e.character) },
      enchanted: done, channel, transcript, summary: sum, verdict: state.verdict, won: state.won }, null, 1));
    console.log(`\nraid record: ${out}`);
  } finally {
    await release();
    console.log('bodies and faculties given back');
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'm59-bossraid.mjs') {
  main().catch(e => { console.error(e); process.exit(1); });
}
