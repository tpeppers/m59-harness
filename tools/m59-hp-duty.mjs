#!/usr/bin/env node
// HP DUTY: WHEN A CHARACTER REACHES A MAX-HEALTH BAND, GIVE IT THAT BAND'S FARM; TAKE IT BACK BELOW.
//
//   node tools/m59-hp-duty.mjs                       who is in which band, and what would change
//   node tools/m59-hp-duty.mjs once --apply          push the changes once
//   node tools/m59-hp-duty.mjs watch --fleet prod    every --minutes (10), until --hours (72)
//
// Operator, 2026-10-07: "Everyone who hits 75 hps should go start doing 'living trees'-duty
// farming entroot berries and more wands for the guild." Max health is the advancement clock: a
// kill raises it only while the creature's level is above it (docs/m59-combat.md), so at 75 the
// level-75 skeleton of Castle Victoria stops paying and the character is better spent on the
// guild's economy. A death costs max health, so a character can fall back out of the band; it is
// then handed back the orders it had before, because room 38 pays it again at 74.
//
// THE BAND CAN REQUIRE A SKILL FIRST. Same day: "make sure everyone gets to level 4 weaponcraft
// first". Living trees are level 50, and a weapon proficiency stops improving at the target's
// level (stroke.kod:115), so a character moved to trees before Parry could never train its axe past
// 50 — and most of the eleven without Parry need more than that. `requires: ["parry"]` keeps a
// character where it is until it holds the skill.
//
// CONFIG, private (it names characters): substrate/hp-duty.json
//   { "agents": ["t1", ...],                 who is eligible at all (default: every t<N> on the roster)
//     "except": ["Pepe", "Statler"],         by character name: never moved
//     "bands": [ { "name": "living-tree-duty", "at_least": 75, "requires": ["parry"],
//                  "order": { "farm_strategy": "living-tree-duty", "assigned_room": 537,
//                             "confine_rooms": [537, 536] } } ] }
// STATE, private: substrate/hp-duty-state.json — per agent, the band it is in and the orders it
// had before, so leaving the band restores exactly those keys.
//
// It writes through the broker's `autopilot` tool (action=start), which records the order in the
// roster and pushes it to the keeper; a farm strategy's own keys come from its file. One order per
// character per change, never a re-push of an unchanged band — a push resets nothing, but a loop
// that re-asserts every ten minutes is a loop that fights every other writer.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const norm = s => String(s ?? '').trim().toLowerCase();
/** The order keys a band may set, and the policy field each one is read back from. */
export const ORDER_KEYS = Object.freeze({ farm_strategy: 'farmStrategy', assigned_room: 'assignedRoom',
  confine_rooms: 'confineRooms', hunt: 'hunt', mode: null });

/** The highest band a character qualifies for, or null. Pure. */
export function bandFor({ maxHealth, skills = [], character, config }) {
  if ((config.except ?? []).some(n => norm(n) === norm(character))) return null;
  const known = new Set(skills.map(norm));
  const bands = [...(config.bands ?? [])].sort((a, b) => b.at_least - a.at_least);
  return bands.find(b => maxHealth >= b.at_least && (b.requires ?? []).every(r => known.has(norm(r)))) ?? null;
}

/**
 * What to push for one character. Pure.
 * `orders` is the character's current orders (policy keys), `prior` the state entry.
 * Returns { action: 'enter'|'leave'|'stay'|'none', push?, save?, why }.
 */
export function decide({ agent, character, maxHealth, skills, orders, prior, config }) {
  const band = bandFor({ maxHealth, skills, character, config });
  const inBand = prior?.band ?? null;
  if (band && inBand === band.name) return { action: 'stay', why: `in ${band.name} at ${maxHealth} max health` };
  if (band) {
    // Remember what this band is about to overwrite, unless we already hold an older copy (a
    // move from one band to another keeps the ORIGINAL orders, not the previous band's).
    const before = prior?.before ?? Object.fromEntries(Object.entries(ORDER_KEYS)
      .filter(([k, field]) => field && k in band.order).map(([k, field]) => [k, orders?.[field] ?? null]));
    return { action: 'enter', push: { mode: 'farm', ...band.order }, save: { band: band.name, before },
             why: `${maxHealth} max health reaches ${band.name} (${band.at_least}+)` };
  }
  if (inBand) {
    // Every saved key goes back, null included: null is "unassigned", which is what it was.
    const back = { ...(prior.before ?? {}) };
    return { action: 'leave', push: { mode: 'farm', ...back }, save: null,
             why: `${maxHealth} max health is below ${inBand} — restoring the orders it had before` };
  }
  const missing = (config.bands ?? []).filter(b => maxHealth >= b.at_least)
    .flatMap(b => (b.requires ?? []).filter(r => !skills.map(norm).includes(norm(r))));
  return { action: 'none', why: missing.length ? `${maxHealth} max health, waiting on ${[...new Set(missing)].join(', ')}`
                                              : `${maxHealth} max health, no band` };
}

// ------------------------------------------------------------------------------------- cli
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const has = n => argv.includes(`--${n}`);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'show';
  const root = resolve(flag('root', join(HERE, '..')));
  const fleet = flag('fleet', process.env.M59_FLEET || 'prod');
  const configFile = join(root, 'substrate', 'hp-duty.json');
  const stateFile = join(root, 'substrate', 'hp-duty-state.json');
  if (!existsSync(configFile)) { console.error(`no ${configFile} — nothing is configured`); process.exit(2); }
  const { call } = await import('./m59-fleetscript.mjs');
  const parse = r => typeof r === 'string' ? (() => { try { return JSON.parse(r); } catch { return { text: r }; } })() : r;

  const round = async (apply) => {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
    const roster = JSON.parse(readFileSync(join(root, 'substrate', 'fleets', `${fleet}.json`), 'utf8'));
    const agents = config.agents ?? Object.keys(roster).filter(a => /^t\d+$/.test(a));
    for (const agent of agents) {
      const character = roster[agent]?.credentials?.character ?? agent;
      try {
        const st = parse(await call('autopilot', { action: 'status', agent }, 60_000));
        const ab = parse(await call('abilities', { agent }, 60_000));
        const vit = parse(await call('status', { agent }, 60_000));
        const maxHealth = Number(vit?.hp?.max ?? vit?.vitals?.health?.max ?? vit?.health?.max);
        if (!Number.isFinite(maxHealth)) { console.log(`${agent} ${character}: max health unreadable — skipped`); continue; }
        const skills = [...(ab?.skills ?? []), ...(ab?.abilities ?? [])].map(x => x?.name ?? x).filter(Boolean);
        const orders = st?.policy_orders ?? st?.policy ?? {};
        const d = decide({ agent, character, maxHealth, skills, orders, prior: state[agent], config });
        console.log(`${new Date().toISOString()} ${agent.padEnd(4)} ${character.padEnd(10)} ${d.action.padEnd(5)} ${d.why}`);
        if (!apply || !d.push) continue;
        const r = parse(await call('autopilot', { action: 'start', agent, ...d.push }, 90_000));
        if (r?.keeper_push?.ok === false || r?.error) { console.log(`  push refused: ${r?.error ?? JSON.stringify(r?.keeper_push)}`); continue; }
        if (d.save) state[agent] = d.save; else delete state[agent];
        writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n');
        renameSync(stateFile + '.tmp', stateFile);
      } catch (e) { console.log(`${agent} ${character}: ${e.message}`); }
    }
  };

  if (cmd === 'watch') {
    const until = Date.now() + Number(flag('hours', 72)) * 3600e3;
    const every = Number(flag('minutes', 10)) * 60_000;
    console.log(`hp-duty watching fleet ${fleet} every ${every / 60_000} min until ${new Date(until).toISOString()}`);
    while (Date.now() < until) { await round(true); await new Promise(r => setTimeout(r, every)); }
  } else {
    await round(cmd === 'once' && has('apply'));
    if (!(cmd === 'once' && has('apply'))) console.log('(nothing pushed — `once --apply` to push, `watch` to keep doing it)');
  }
  process.exit(0);
}
