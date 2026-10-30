#!/usr/bin/env node
// A PVP BATTLE, REPLAYABLE: WHO STOOD WHERE, WHAT EACH SIDE DID, AND WHAT IT COST, OVER TIME.
//
//   node tools/m59-pvp-replay.mjs --list                    # battles in the last 7 days, with ids
//   node tools/m59-pvp-replay.mjs --battle latest           # build (and cache) one replay
//   node tools/m59-pvp-replay.mjs --battle <id> --json      # the replay itself
//   node tools/m59-pvp-replay.mjs --dossier [--days 7]      # every battle's aggregates, as text
//   node tools/m59-pvp-replay.mjs --build-all               # build every replay in the window
//
// The geometry server draws these: http://127.0.0.1:8977/replay/<battle id>
//
// ---------------------------------------------------------------------------
// WHY
//
// Operator, 2026-10-29: "seeing timestamps and '+31s' between events means a little less the 8th
// time I'm reading it ... it's very hard to get an accurate understanding from just the text logs."
// The /pvp page (tools/m59-pvp.mjs, tools/m59-pvp-telemetry.mjs) already joins every swing, cast
// and server sentence into one timeline. What it cannot show is the GEOMETRY of a fight: who was
// chasing whom, who stood behind a wall, who was kiting at six squares while ours walked into a
// fire wall. That is what this module adds, and it adds it from evidence that was already on disk:
//
//   TRAILS   substrate/trails/<fleet>*.jsonl — every player move packet the fleet saw, ours and
//            theirs, in KOD fine units (64 to the square). Rows carry an OBJECT ID and no name,
//            and the room as an object id plus its resources, so both are resolved here: rooms
//            through the map's resources (m59-trails resolveRoom), bodies through the ids the
//            action and shot rows name, and our own bodies by matching their logged locations.
//   ACTIONS, MESSAGES, COMBAT ROWS, SHOTS, CALLOUTS — the PvP side files (m59-pvp.mjs). Every one
//            of them that carries a location stamp contributes a track point too.
//
// THE DAMAGE ESTIMATES are the verb tiers of reports/combat-message-damage-ranges.md in the
// m59-research corpus (battler.kod GetDamageDesc, :414; the PvP ⅓ override at :926-933; the cap at
// player.kod:4602-4628). No HP is logged anywhere in the PvP files — every number here is a RANGE,
// and the page says so. Our own max HP is read from the stats page's source (substrate/fleets) when
// present; an enemy's never is, so an outgoing "damage" verb is 16–34.
//
// The output is cached under substrate/pvp/<fleet>/replays/<id>.json, keyed on the battle's own
// span: a replay of a battle that has ended does not change, and building one reads a slice of a
// 480 MB trail file (binary-searched by time, never read whole).

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync,
         openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pvpReport, pvpDirFor, rosterAliases } from './m59-pvp.mjs';
import { classifyMessage } from './m59-pvp-telemetry.mjs';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';
import { movementMapFile } from './m59-map-path.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');
export const REPLAY_SCHEMA = 'm59-pvp-replay/1';
// Where the fleet's evidence lives. `M59_EVIDENCE_DIR` points a checkout at another tree's substrate
// (a worktree reading prod's sheets and trails); the default is this checkout's own.
const SUBSTRATE = (env = process.env) => env.M59_EVIDENCE_DIR ?? join(HERE, 'substrate');

// ------------------------------------------------------------------ the verb tiers

// battler.kod:58-137, family by family: [nick, wound, damage, slay].
const FAMILIES = {
  generic: ['nicks', 'wounds', 'damages', 'slays'],
  slash: ['cuts', 'slashes', 'maims', 'cleaves'],
  thrust: ['pokes', 'stabs', 'impales', 'runs through'],
  bludgeon: ['bashes', 'crushes', 'smashes', 'brutalizes'],
  pierce: ['grazes', 'pierces', 'lacerates', 'fells'],
  punch: ['slaps', 'pummels', 'mangles', 'thrashes'],
  fire: ['singes', 'chars', 'scorches', 'incinerates'],
  shock: ['jolts', 'shocks', 'fries', 'electrocutes'],
  cold: ['cools', 'chills', 'frosts', 'freezes'],
  acid: ['burns', 'sears', 'disfigures', 'dissolves'],
  holy: ['infuses', 'cleanses', 'mortifies', 'purifies'],
  unholy: ['maligns', 'pollutes', 'appalls', 'corrupts'],
  quake: ['shakes', 'buffets', 'slams', 'flattens'],
  bite: ['nips', 'bites', 'gnaws', 'devours'],
  claw: ['claws', 'rakes', 'rends', 'shreds'],
  sting: ['irritates', 'stings', 'pricks', 'impales'],
};
const TIERS = ['nick', 'wound', 'damage', 'slay'];
export const ASSUMED_ENEMY_MAX_HP = 100;
// "impales" is thrust DAMAGE and sting SLAY (battler.kod:130, :109); stings are monsters' only,
// so the first family listed wins and a monster's impale is read below by its weapon name.
const VERB = new Map();
for (const [family, verbs] of Object.entries(FAMILIES)) verbs.forEach((v, i) => {
  if (!VERB.has(v)) VERB.set(v, { family, tier: TIERS[i] });
});
const VERB_RE = [...VERB.keys()].sort((a, b) => b.length - a.length).map(v => v.replace(' ', '\\s')).join('|');

/**
 * HP range of one hit. `defMax` is the defender's max HP when it is a player we know; `pvp` says the
 * defender is a player at all (the ⅓ override and the cap apply only then); `shield` is the faction
 * shield ×1.15 (player.kod:4620-4628) — every PvP kill on this fleet in October was a faction kill.
 */
export function hitRange(tier, { pvp = false, defMax = null, shield = false } = {}) {
  if (!pvp) return tier === 'nick' ? [1, 5] : tier === 'wound' ? [6, 15] : tier === 'damage' ? [16, null] : [1, null];
  const T = defMax ? Math.floor(defMax / 3) : 6;                       // worst case: the 20-HP floor
  const C = Math.min(30, defMax ? Math.ceil(defMax / 3) : 30);
  const cap = shield ? Math.floor(C * 115 / 100) : C;
  if (tier === 'nick') return [1, Math.max(1, Math.min(5, T - 1))];
  if (tier === 'wound') return [6, Math.max(6, Math.min(15, T - 1))];
  if (tier === 'damage') return [Math.min(16, T), cap];
  return [1, cap];                                                      // slay: ≥ what was left
}

// ------------------------------------------------------------------ reading one server sentence

const clean = t => String(t ?? '').replace(/~[A-Za-z]/g, '').trim();
const ART = /^(?:an?|the)\s/i;
const isMonsterName = n => ART.test(n ?? '');

/**
 * One sentence as the replay sees it: a category (what the autopause list and the colours key on),
 * who did it to whom, and an HP range when the sentence carries one. `observer` is the one of ours
 * who heard it, which is who "you" is.
 */
export function readSentence(text, { observer = null, isOurs = () => false, maxHp = () => null } = {}) {
  const t = clean(text);
  const base = classifyMessage(t);
  let m;
  // --- hits ON us: "<X> <verb> you with his <weapon>."
  if ((m = new RegExp(`^(.+?) (${VERB_RE}) you with (?:his|her|its|their) (.+?)\\.$`, 'i').exec(t))) {
    const v = VERB.get(m[2].toLowerCase().replace(/\s+/, ' '));
    const attacker = m[1], pvp = !isMonsterName(attacker);
    const tier = (v.family === 'thrust' && v.tier === 'damage' && !pvp && /attack/.test(m[3])) ? 'slay' : v.tier;
    return { cat: pvp ? 'hit_in_player' : 'hit_in_monster', actor: attacker, target: observer, weapon: m[3],
      verb: m[2], family: v.family, tier, hp: hitRange(tier, { pvp: true, defMax: maxHp(observer), shield: pvp }) };
  }
  // --- our hits: "Your <weapon> <verb> <X>."
  if ((m = new RegExp(`^Your (.+?) (${VERB_RE}) (.+?)\\.$`, 'i').exec(t))) {
    const v = VERB.get(m[2].toLowerCase().replace(/\s+/, ' '));
    const target = m[3].replace(ART, ''), pvp = !isMonsterName(m[3]);
    // An enemy's max HP is never sent. Every player who has killed ours this month out-lasts a dozen
    // hits, so the bands assume one of 88+ HP: nick 1–5, wound 6–15, damage 16–34.
    return { cat: pvp ? 'hit_out' : 'hit_out_monster', actor: observer, target: m[3], weapon: m[1], verb: m[2],
      family: v.family, tier: v.tier, hp: hitRange(v.tier, { pvp, defMax: pvp ? ASSUMED_ENEMY_MAX_HP : null, shield: pvp }), pvp, target_name: target };
  }
  // --- the death-blow extras (player.kod:223-228): a kill line beside the hit line, no number
  if ((m = /^(.+?)(?:'s fire flares brightly| grins as a jolt of electricity| slashes your side| skewers you with a deft thrust)/.exec(t)))
    return { cat: 'killing_blow', actor: m[1], target: observer };
  if (/^You are dead, poor soul/.test(t)) return { cat: 'died', actor: /revenge on (.+?)!$/.exec(t)?.[1] ?? null, target: observer };
  // --- walls (wallfire.kod:25-29): <5, <10, <15, 15+
  if (/^You feel a bit toasted from the flames/.test(t)) return { cat: 'wall_in', target: observer, effect: 'fire wall', hp: [1, 4] };
  if (/^Something smells like burnt hair/.test(t)) return { cat: 'wall_in', target: observer, effect: 'fire wall', hp: [5, 9] };
  if (/^You are on fire!  ?Put it out/.test(t)) return { cat: 'wall_in', target: observer, effect: 'fire wall', hp: [10, 14] };
  if (/^Ouch, that really burned/.test(t)) return { cat: 'wall_in', target: observer, effect: 'fire wall', hp: [15, null] };
  if (/^You withstand the fire unscathed/.test(t)) return { cat: 'wall_in', target: observer, effect: 'fire wall', hp: [0, 0] };
  // --- wands (vampwand.kod: 2–6 raw, unholy+shock; no verb)
  if ((m = /^You shiver uncontrollably as (.+?) drains your life force away/.exec(t)))
    return { cat: 'hit_in_player', actor: m[1], target: observer, weapon: 'vampiric wand', family: 'unholy', tier: 'wand', hp: [1, 6] };
  if ((m = /^You narrowly dodge (.+?)'s ominous wand attack/.exec(t)))
    return { cat: 'miss_in', actor: m[1], target: observer, weapon: 'vampiric wand' };
  if ((m = /^You (?:cackle with glee as|feel giddy with energy as) (.+?)'s life force/.exec(t)))
    return { cat: 'hit_out', actor: observer, target: m[1], weapon: 'vampiric wand', tier: 'wand', hp: [1, 6], pvp: !isMonsterName(m[1]) };
  if ((m = /^You watch with satisfaction as a ball of fire engulfs (.+?)!/.exec(t)))
    return { cat: 'hit_out', actor: observer, target: m[1], weapon: 'wand of fire', tier: 'wand', hp: [1, 10], pvp: !isMonsterName(m[1]) };
  if ((m = /^(.+?) narrowly dodges your (\w+) attack/.exec(t)))
    return { cat: 'miss_out', actor: observer, target: m[1], weapon: `${m[2]} wand`, how: 'dodged' };
  // --- resistance ladders (player.kod:208-218)
  if ((m = /^(.+?) (laughs off your pitiful blow|shrugs off your attack|staggers backwards from the blow|convulses and seems to be suffering badly)/.exec(t)))
    return { cat: 'resist_out', actor: observer, target: m[1], effect: m[2] };
  if (/^(Mysteriously, you feel almost no pain|Much of the pain fades away|The pain seems to resonate|Your body is wracked with pain)/.test(t))
    return { cat: 'resist_in', target: observer, effect: t };
  // --- misses both ways
  if ((m = /^You (dodge|block|parry|avoid) (.+?)'s attack\.$/.exec(t)))
    return { cat: 'miss_in', actor: m[2], target: observer, how: m[1], monster: isMonsterName(m[2]) };
  if ((m = /^(.+?) (dodges|blocks|parries|avoids) your attack\.$/.exec(t)))
    return { cat: 'miss_out', actor: observer, target: m[1], how: m[2], monster: isMonsterName(m[1]) };
  if (/^You miss/.test(t)) return { cat: 'miss_out', actor: observer, how: 'missed' };
  if ((m = /^(.+?) is too far away to hit with (?:an? )?(.+?)\.$/.exec(t)))
    return { cat: 'refused', actor: observer, target: m[1], why: 'out of reach', weapon: m[2] };
  // --- the rules that stop ours fighting back
  if ((m = /^Hey!  ?You almost hit (.+?)!  ?Good thing your safety was on/.exec(t)))
    return { cat: 'refused', actor: observer, target: m[1], why: 'safety (same faction or not attackable)' };
  if ((m = /^Silly you!  ?You almost fried (.+?)!/.exec(t)))
    return { cat: 'refused', actor: observer, target: m[1], why: 'safety (wand)' };
  if ((m = /^You are not vile enough to cast (.+?)!/.exec(t)))
    return { cat: 'refused', actor: observer, why: `karma: not vile enough for ${m[1]}`, spell: m[1] };
  if ((m = /^You are not (?:holy|good|pure) enough to cast (.+?)!/.exec(t)))
    return { cat: 'refused', actor: observer, why: `karma: not good enough for ${m[1]}`, spell: m[1] };
  if (/^You can't see your selected target/.test(t)) return { cat: 'refused', actor: observer, why: "can't see target" };
  if (/^You've attacked a player too recently/.test(t)) return { cat: 'refused', actor: observer, why: 'attacked a player too recently' };
  if ((m = /^You can't use (?:an? |the )?(.+?)--it's broken/.exec(t))) return { cat: 'refused', actor: observer, why: `broken: ${m[1]}` };
  if ((m = /^The (wand.*?) shatters into pieces/.exec(t))) return { cat: 'gear', actor: observer, effect: `${m[1]} shattered` };
  // --- effects landing on us (hold.kod:28, blind.kod:29, Dazzle.kod:28, ...)
  const ON = [
    [/^A magical tingling pulses through your body/, 'held'], [/^Something burns in your eyes/, 'blinded'],
    [/^The world is washed away in a flood of pure light/, 'dazzled'], [/^Your stomach leaps into your throat/, 'vertigo'],
    [/^The art of (.+?) slips from your mind/, 'forgot a spell'], [/^As you meet .+?'s terrible gaze/, 'paralyzed (gaze)'],
    [/^You sense an unsavory presence/, 'enfeebled?'], [/^Your legs feel heavy|^You feel sluggish/, 'slowed'],
  ];
  for (const [re, effect] of ON) if (re.test(t)) return { cat: 'effect_in', target: observer, effect };
  const OFF = [[/^The magical hold lifts/, 'hold ended'], [/^Your eyes begin to function again/, 'blind ended'], [/^Your vision begins to clear/, 'dazzle ended']];
  for (const [re, effect] of OFF) if (re.test(t)) return { cat: 'effect_off', target: observer, effect };
  // --- their casts, as the room sees them (spell.kod:110-112)
  if (base.cls === 'cast_seen') {
    const caster = base.caster, tgt = base.target;
    const self = tgt && clean(tgt).toLowerCase() === clean(caster).toLowerCase();
    return { cat: isOurs(caster) ? 'cast_ours_seen' : isMonsterName(caster) ? 'cast_monster' : 'cast_enemy', actor: caster,
      target: tgt ? (/^you$/i.test(tgt) ? observer : tgt) : null, self, untargeted: !tgt };
  }
  if ((m = /^(.+?) magically sweeps some of the items in the area into/.exec(t))) return { cat: 'cast_enemy', actor: m[1], spell: 'sweep', effect: 'looted the area (sweep)' };
  if (/^(### )?(.+?) was (bested by faction rival|just killed by|killed by)/.test(t) || base.cls === 'death') return { cat: 'broadcast', effect: t };
  if (/safety is now/.test(t)) return { cat: 'safety_toggle', actor: observer, effect: /OFF/.test(t) ? 'safety off' : 'safety on' };
  // --- our own spell replies (the telemetry classes)
  if (base.cls.startsWith('spell_')) return { cat: 'spell_reply', actor: observer, cls: base.cls, spell: base.spell ?? null, target: base.target ?? null, effect: base.effect ?? null };
  if (base.cls === 'chat') return { cat: 'chat' };
  return { cat: 'other', cls: base.cls };
}

// ------------------------------------------------------------------ trails, read by time

function lineAt(fd, size, pos) {
  // The first complete line at or after `pos`.
  const buf = Buffer.alloc(4096);
  let start = pos;
  if (pos > 0) {
    let off = pos, found = -1;
    while (off < size && found < 0) {
      const n = readSync(fd, buf, 0, buf.length, off);
      if (!n) break;
      const i = buf.subarray(0, n).indexOf(10);
      if (i >= 0) found = off + i + 1; else off += n;
    }
    if (found < 0) return null;
    start = found;
  }
  const n = readSync(fd, buf, 0, buf.length, start);
  const i = buf.subarray(0, n).indexOf(10);
  const text = buf.subarray(0, i >= 0 ? i : n).toString('utf8');
  const at = Number(/"at":(\d+)/.exec(text)?.[1]);
  return Number.isFinite(at) ? { start, at } : null;
}

/** The byte offset at which rows reach `t` (a lower bound, 30s early so out-of-order keepers are kept). */
function seekTime(fd, size, t) {
  let lo = 0, hi = size;
  for (let k = 0; k < 60 && hi - lo > 8192; k++) {
    const mid = Math.floor((lo + hi) / 2);
    const l = lineAt(fd, size, mid);
    if (!l || l.at >= t - 30_000) hi = mid; else lo = mid;
  }
  return lo;
}

function trailFiles(fleet, dir) {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${fleet.replace(/[^\w-]/g, '')}(?:-(\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z))?\\.jsonl$`);
  return readdirSync(dir).map(f => ({ f, m: re.exec(f) })).filter(x => x.m).map(({ f, m }) => {
    // a rotated file is named for the moment it was rotated: its END
    const end = m[1] ? Date.parse(m[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z')) : Infinity;
    return { file: join(dir, f), end };
  }).sort((a, b) => a.end - b.end);
}

/** Rows of one time-ordered JSONL file between two times, binary-searched: never reads the file whole. */
export function readJsonlWindow(file, since, until, { slackMs = 30_000 } = {}) {
  const out = [];
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    let pos = seekTime(fd, size, since);
    const buf = Buffer.alloc(1 << 20);
    let carry = '', done = false;
    while (!done && pos < size) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const lines = (carry + buf.subarray(0, n).toString('utf8')).split('\n');
      carry = lines.pop();
      for (const l of lines) {
        const at = Number(/"at":(\d+)/.exec(l)?.[1]);
        if (!(at >= since)) continue;
        if (at > until + slackMs) { done = true; break; }
        if (at > until) continue;
        try { out.push(JSON.parse(l)); } catch {}
      }
    }
  } catch { /* missing or unreadable: a thinner picture */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return out;
}

/** A PvP side file's rows (`actions`, `messages`, `shots`, `callouts`) between two times, read by window. */
export function readSideWindow(prefix, { dir = pvpDirFor(), since, until } = {}) {
  const out = [];
  for (let t = Date.parse(new Date(since).toISOString().slice(0, 10)); t <= until; t += 86_400_000) {
    const f = join(dir, `${prefix}-${new Date(t).toISOString().slice(0, 10)}.jsonl`);
    if (existsSync(f)) out.push(...readJsonlWindow(f, since, until));
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Every trail row between two times, from whichever files cover them. Never reads a file whole. */
export function readTrails({ fleet = fleetName() || 'default', dir = join(SUBSTRATE(), 'trails'), since, until } = {}) {
  const files = trailFiles(fleet, dir);
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const prevEnd = i ? files[i - 1].end : -Infinity;
    if (files[i].end < since || prevEnd > until) continue;
    out.push(...readJsonlWindow(files[i].file, since, until));
  }
  return out.sort((a, b) => a.at - b.at);
}

// ------------------------------------------------------------------ names for bodies, from the ledger

// The travel ledger's decision rows carry `bodies` — every body in view, by id AND name — which is
// the only record that names a trail id for a character of ours who did nothing during a fight.
// Ids are renumbered at every server save and recycled within hours (CLAUDE.md, "an object id is a
// temporary handle"), so each id takes the name seen NEAREST in time to the battle, never an old one.
export function readLedgerBodies({ dir = ledgerDirFor(fleetName() || ''), since, until } = {}) {
  const out = [];   // { t, id, name }
  const days = new Set();
  for (let t = since - 86_400_000; t <= until + 86_400_000; t += 86_400_000) days.add(new Date(t).toISOString().slice(0, 10));
  for (const d of days) {
    const f = join(dir, `fleet-${d}.jsonl`);
    if (!existsSync(f)) continue;
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const re = /"bodies":\[/g;
    let m;
    while ((m = re.exec(text))) {
      const ls = text.lastIndexOf('\n', m.index) + 1;
      const t = Number(/"t":(\d+)/.exec(text.slice(ls, ls + 40))?.[1]);
      if (!(t >= since && t <= until)) continue;
      const le = text.indexOf('\n', m.index);
      const body = text.slice(m.index, le < 0 ? undefined : le);
      for (const b of body.matchAll(/\{"id":(\d+),"x":-?\d+,"y":-?\d+(?:,"row":\d+,"col":\d+)?,"kind":"player","name":"((?:[^"\\]|\\.)+)"/g))
        out.push({ t, id: Number(b[1]), name: b[2] });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the map index

let MAP = null;
function mapIndex() {
  if (MAP) return MAP;
  const byName = new Map(), byRsc = new Map(), names = {};
  try {
    const w = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
    for (const [k, r] of Object.entries(w.rooms ?? {})) {
      const num = Number(r.num ?? k);
      if (r.nameRsc != null) byName.set(Number(r.nameRsc), num);
      if (r.roomRsc != null) byRsc.set(Number(r.roomRsc), num);
      names[num] = { name: r.name ?? null, rows: r.rows ?? null, cols: r.cols ?? null };
    }
  } catch { /* numbers only */ }
  return (MAP = { byName, byRsc, names });
}
const trailMap = r => {
  const ix = mapIndex();
  return ix.byName.get(Number(r.room_name_rsc)) ?? ix.byRsc.get(Number(r.room_rsc)) ?? null;
};

// ------------------------------------------------------------------ max HP, for the PvP bands

/** Character -> max HP, from the character sheets (m59-sheet: vitals.health.max). A missing one is null. */
export function readMaxHp(dir = join(SUBSTRATE(), 'sheets')) {
  const out = new Map();
  try {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const mx = j?.vitals?.health?.max;
        if (j?.character && Number.isFinite(mx)) out.set(j.character.toLowerCase(), mx);
      } catch {}
    }
  } catch {}
  return out;
}

// ------------------------------------------------------------------ one battle -> a replay

const norm = n => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Build one battle's replay. `battle` is a summarized battle from pvpReport (with `events` and
 * `telemetry`); the side rows are passed in so a test can build one from fixtures.
 */
export function buildReplay(battle, { actions = [], messages = [], shots = [], callouts = [], trails = [], bodies = [],
                                      isOurs = () => false, maxHp = new Map(), factions = {},
                                      padBefore = 45_000, padAfter = 30_000 } = {}) {
  const lo = battle.start - padBefore, hi = battle.end + padAfter;
  const ourNames = new Set((battle.ours ?? []).map(o => norm(o.name)));
  const enemyNames = new Set((battle.enemies ?? []).map(e => norm(e.name)));
  const maps = new Set(battle.rooms ?? []);
  const inWin = r => r.at >= lo && r.at <= hi;
  const mine = r => ourNames.has(norm(r.observer)) || (r.room != null && maps.has(r.room)) || (r.loc?.map != null && maps.has(r.loc.map));
  const acts = actions.filter(r => inWin(r) && mine(r));
  // an observer who acted in the window is in the battle, even if the battle summary never named it
  for (const a of acts) if (a.observer) ourNames.add(norm(a.observer));
  for (const a of acts) { if (a.loc?.map != null) maps.add(a.loc.map); if (a.verb === 'traverse') { if (a.from != null) maps.add(a.from); if (a.to != null) maps.add(a.to); } }
  const ours = n => ourNames.has(norm(n)) || isOurs(n);
  const hpOf = n => maxHp.get(norm(n)) ?? null;

  // --- names for ids: what the rows say outright
  const idName = new Map();
  const nameId = (id, name, how) => {
    if (id == null || !name || name === 'self') return;
    const k = Number(id); if (!Number.isFinite(k) || k <= 0) return;
    if (!idName.has(k)) idName.set(k, { name, how });
  };
  for (const a of acts) {
    if (a.target != null && a.target_player && a.target_name) nameId(a.target, a.target_name, 'action target');
    if (a.target != null && a.target_name === 'self') nameId(a.target, a.observer, 'self-cast');
  }
  for (const s of shots.filter(inWin)) if (s.target?.id != null && s.target?.name) {
    const proper = [...enemyNames, ...ourNames].find(n => n === norm(s.target.name));
    nameId(s.target.id, proper ? (battle.enemies.find(e => norm(e.name) === proper)?.name ?? s.target.name) : s.target.name, 'shot target');
  }

  // the ledger's named bodies, nearest in time to the fight
  const mid = (battle.start + battle.end) / 2, nearest = new Map();
  for (const b of bodies) {
    const prev = nearest.get(b.id);
    if (!prev || Math.abs(b.t - mid) < Math.abs(prev.t - mid)) nearest.set(b.id, b);
  }
  for (const [id, b] of nearest) nameId(id, b.name, 'ledger bodies');

  // --- track points from the side files (named already)
  const pts = [];   // { t, name, map, x, y, src }
  const addPt = (t, name, loc, src) => {
    if (!name || !loc || loc.x == null || loc.y == null || loc.map == null) return;
    pts.push({ t, name, map: loc.map, x: loc.x, y: loc.y, src });
  };
  for (const a of acts) {
    addPt(a.at, a.observer, a.loc, 'action');
    if (a.target_name && a.target_name !== 'self' && a.target_loc) addPt(a.at, a.target_name, a.target_loc, 'action target');
  }
  for (const e of battle.events ?? []) if (e.kind === 'combat' && e.loc && inWin(e)) addPt(e.at, e.observer, e.loc, 'combat');
  for (const s of shots.filter(inWin)) {
    const map = s.room ?? null;
    if (s.sight?.me) addPt(s.at, s.character, { map, x: s.sight.me.x, y: s.sight.me.y }, 'shot');
    if (s.sight?.tgt && s.target?.id != null) {
      const nm = idName.get(Number(s.target.id))?.name ?? s.target.name;
      addPt(s.at, nm, { map, x: s.sight.tgt.x, y: s.sight.tgt.y }, 'shot target');
    }
  }
  for (const c of callouts.filter(inWin)) if (c.loc) addPt(c.at, c.speaker, c.loc, 'callout');

  // --- trails: resolve each row's map, then name our bodies by matching their logged spots
  const tr = [];
  for (const r of trails) {
    if (!inWin(r) || r.x == null || r.y == null) continue;
    const map = trailMap(r);
    if (map == null || !maps.has(map)) continue;
    tr.push({ t: r.at, id: Number(r.id), map, x: r.x, y: r.y });
  }
  const votes = new Map();   // id -> name -> n
  const byMap = new Map();
  for (const r of tr) (byMap.get(r.map) ?? byMap.set(r.map, []).get(r.map)).push(r);
  for (const p of pts) {
    if (!ours(p.name)) continue;
    const rows = byMap.get(p.map) ?? [];
    for (const r of rows) {
      if (Math.abs(r.t - p.t) > 1500) continue;
      if (Math.abs(r.x - p.x) <= 2 && Math.abs(r.y - p.y) <= 2) {
        const v = votes.get(r.id) ?? new Map(); v.set(p.name, (v.get(p.name) ?? 0) + 1); votes.set(r.id, v);
      }
    }
  }
  for (const [id, v] of votes) {
    if (idName.has(id)) continue;
    const [name, n] = [...v].sort((a, b) => b[1] - a[1])[0];
    if (n >= 2) idName.set(id, { name, how: `matched ${n} logged positions` });
  }
  const unknown = new Map();
  for (const r of tr) {
    const known = idName.get(r.id);
    let name = known?.name;
    if (!name) {
      if (!unknown.has(r.id)) unknown.set(r.id, `player #${r.id}`);
      name = unknown.get(r.id);
    }
    pts.push({ t: r.t, name, map: r.map, x: r.x, y: r.y, src: 'trail' });
  }

  // --- actors and their tracks (decimated: one point per 150 ms per body)
  const side = n => ours(n) ? 'ours' : (enemyNames.has(norm(n)) ? 'enemy' : (/^player #/.test(n) ? 'unknown' : 'other'));
  const tracks = {};
  for (const p of pts.sort((a, b) => a.t - b.t)) {
    const k = p.name;
    const tk = tracks[k] ??= [];
    const last = tk.at(-1);
    if (last && last[1] === p.map && p.t - last[0] < 150) { if (p.src !== 'trail') { last[2] = p.x; last[3] = p.y; } continue; }
    tk.push([p.t, p.map, p.x, p.y]);
  }
  // our deaths end a track on that map: the body is gone, the next point is wherever it respawned
  const deaths = (battle.events ?? []).filter(e => e.kind === 'death');
  const actors = Object.keys(tracks).map(name => ({ name, side: side(name), faction: factions[norm(name)] ?? null,
    max_hp: hpOf(name), id: [...idName].find(([, v]) => v.name === name)?.[0] ?? null,
    deaths: deaths.filter(d => norm(d.victim) === norm(name)).map(d => d.at) }));
  for (const e of battle.enemies ?? []) if (!tracks[e.name]) actors.push({ name: e.name, side: 'enemy', faction: factions[norm(e.name)] ?? null, max_hp: null, id: null, deaths: [] });

  // --- the timeline: battle events + actions + every sentence, each with a category
  const events = [];
  const push = (e) => { if (e.t >= lo && e.t <= hi) events.push(e); };
  for (const e of battle.events ?? []) {
    if (e.kind === 'death') push({ t: e.at, cat: e.our_death ? 'death_ours' : 'death_enemy', actor: e.killer, target: e.victim, map: e.room ?? null,
      text: `${e.victim} killed by ${e.killer ?? '?'}${e.how ? ` (${e.how})` : ''}` });
    else if (e.kind === 'alarm') push({ t: e.at, cat: 'alarm', actor: e.observer, target: e.enemies?.[0], map: e.room ?? null,
      text: `${e.observer} raises the alarm: ${e.enemies?.[0] ?? '?'} (${e.basis})` });
    else if (e.kind === 'combat' && e.event === 'pvp_attacked_outside_rooms') {
      // Hit where the policy forbids answering (m59-pvp-rooms.mjs): the sentence is the only record of the hit.
      const r = readSentence(e.text ?? '', { observer: e.observer, isOurs: ours, maxHp: hpOf });
      push({ t: e.at, cat: r.cat === 'other' ? 'decision' : r.cat, actor: r.actor ?? e.attacker, target: r.target ?? e.observer, map: e.room ?? null,
        text: `${clean(e.text ?? '')}  — not returning fire: outside pvp_rooms ${JSON.stringify(e.pvp_rooms ?? [])}`,
        heard_by: e.observer, ...(r.hp ? { hp: r.hp } : {}), ...(r.tier ? { tier: r.tier } : {}), ...(r.weapon ? { weapon: r.weapon } : {}),
        ...(r.family ? { family: r.family } : {}), held_fire: true });
    }
    else if (e.kind === 'combat' && ['pvp_attacked', 'triggered', 'opener_cast', 'finished', 'opener_strategy_fault'].includes(e.event)) push({ t: e.at, cat: 'decision', actor: e.observer,
      target: e.target, map: e.room ?? null, text: `${e.observer}: ${e.event.replace(/_/g, ' ')}${e.target ? ` ${e.target}` : ''}${e.reason ? ` — ${e.reason}` : ''}` });
  }
  const shotAt = new Map(shots.filter(inWin).map(s => [`${norm(s.character)}|${Math.round(s.at / 10)}`, s]));
  for (const a of acts) {
    if (a.verb === 'appearance') continue;
    const tgt = a.target_name && a.target_name !== 'self' ? a.target_name : (a.target_name === 'self' ? a.observer : null);
    const where = a.loc?.map ?? a.room ?? null;
    let cat = 'action', text;
    if (a.verb === 'attack') { cat = 'swing'; text = `${a.observer} swings at ${tgt ?? '?'}${a.dist != null ? ` (${a.dist} sq)` : ''}${a.vetoed ? ' — vetoed, not sent' : ''}`; }
    else if (a.verb === 'cast') { cat = 'cast_ours'; text = `${a.observer} casts ${a.spell ?? '?'}${tgt ? ` on ${tgt}` : ''}${a.dist != null ? ` (${a.dist} sq)` : ''}${a.mana != null ? ` · mana ${a.mana}/${a.max_mana ?? '?'}` : ''}`; }
    else if (a.verb === 'apply') {
      cat = 'wand_out';
      const s = shotAt.get(`${norm(a.observer)}|${Math.round(a.at / 10)}`) ?? shotAt.get(`${norm(a.observer)}|${Math.round(a.at / 10) - 1}`);
      const los = s?.sight ? (s.sight.los === false ? ' · NO line of sight' : '') : '';
      text = `${a.observer} zaps ${a.item_name ?? 'a wand'} at ${tgt ?? '?'}${a.dist != null ? ` (${a.dist} sq)` : ''}${los}`;
    }
    else if (a.verb === 'use' || a.verb === 'unuse') { cat = 'gear'; text = `${a.observer} ${a.verb === 'use' ? 'puts on' : 'takes off'} ${a.item_name ?? '?'}`; }
    else if (a.verb === 'traverse') { cat = 'move'; text = `${a.observer} leaves map ${a.from ?? '?'} for ${a.to ?? '?'}`; }
    else if (a.verb === 'say') { cat = 'chat'; text = `${a.observer}: "${a.text ?? ''}"`; }
    else if (a.verb === 'loot') { cat = 'gear'; text = `${a.observer} loots ${a.item_name ?? ''}`; }
    else text = `${a.observer} ${a.verb}`;
    push({ t: a.at, cat, actor: a.observer, target: tgt, map: where, text, dist: a.dist ?? null, phase: a.phase ?? null });
  }
  // sentences: a third-person line is heard by everyone in the room; keep it once
  const seen = new Map();
  const heard = messages.filter(m => inWin(m) && (ourNames.has(norm(m.observer)) || (m.room != null && maps.has(m.room))));
  for (const m of heard.sort((a, b) => a.at - b.at)) {
    if (m.kind === 'said') {
      const k = `said|${m.speaker}|${m.text}`;
      if (seen.has(k) && m.at - seen.get(k) < 2000) continue;
      seen.set(k, m.at);
      push({ t: m.at, cat: ours(m.speaker) ? 'chat' : 'chat_enemy', actor: m.speaker, map: m.room ?? null, text: clean(m.text) });
      continue;
    }
    const r = readSentence(m.text, { observer: m.observer, isOurs: ours, maxHp: hpOf });
    const text = clean(m.text);
    const third = !/\b(you|your)\b/i.test(text);
    if (third) { if (seen.has(text) && m.at - seen.get(text) < 2000) continue; seen.set(text, m.at); }
    if (r.cat === 'broadcast') continue;   // the deaths are already events
    push({ t: m.at, cat: r.cat, actor: r.actor ?? null, target: r.target ?? null, map: m.room ?? null, text,
      heard_by: m.observer, ...(r.hp ? { hp: r.hp } : {}), ...(r.tier ? { tier: r.tier } : {}), ...(r.weapon ? { weapon: r.weapon } : {}),
      ...(r.family ? { family: r.family } : {}), ...(r.why ? { why: r.why } : {}), ...(r.effect ? { effect: r.effect } : {}),
      ...(r.self ? { self: true } : {}), ...(r.untargeted ? { untargeted: true } : {}), ...(r.cls ? { cls: r.cls } : {}),
      ...(r.spell ? { spell: r.spell } : {}) });
  }
  events.sort((a, b) => a.t - b.t);
  events.forEach((e, i) => { e.i = i; });

  return {
    schema: REPLAY_SCHEMA, id: battle.id, built_at: Date.now(),
    start: battle.start, end: battle.end, t0: lo, t1: hi, result: battle.result,
    kills: battle.kills, our_deaths: battle.our_deaths,
    maps: [...maps].filter(m => m != null).map(num => ({ num, name: mapIndex().names[num]?.name ?? null,
      points: pts.filter(p => p.map === num).length })).sort((a, b) => b.points - a.points),
    actors, tracks, events,
    ids: Object.fromEntries([...idName].map(([id, v]) => [id, v])),
    dossier: dossier({ events, actors, battle }),
    sources: { actions: acts.length, sentences: heard.length, shots: shots.filter(inWin).length,
      trail_rows: tr.length, track_points: pts.length, unnamed_bodies: unknown.size },
  };
}

// ------------------------------------------------------------------ the aggregates

const addRange = (acc, hp) => { if (!hp) return; acc[0] += hp[0] ?? 0; acc[1] = acc[1] == null || hp[1] == null ? null : acc[1] + hp[1]; };

/** What a battle cost each side, by kind, from the categorized timeline. Ranges, never numbers. */
export function dossier({ events, actors, battle }) {
  const enemy = new Set(actors.filter(a => a.side === 'enemy').map(a => norm(a.name)));
  const inc = { player: [0, 0], monster: [0, 0], wall: [0, 0] }, out = { player: [0, 0] };
  const byAttacker = {}, byWeapon = {}, outByWeapon = {}, refused = {}, effectsIn = {}, enemyCasts = {}, ourCasts = {}, spellReplies = {};
  const counts = { swings: 0, swings_vetoed: 0, wand_zaps: 0, wand_hits: 0, wand_dodged: 0, hits_out: 0, hits_out_monster: 0,
    misses_out: 0, hits_in_player: 0, hits_in_monster: 0, misses_in_player: 0, misses_in_monster: 0, resist_out: {}, resist_in: 0,
    out_of_reach: 0, safety: 0, karma: 0, no_los_zaps: 0, enemy_self_casts: 0, enemy_casts_at_us: 0, enemy_untargeted_casts: 0,
    walls: 0, sweeps: 0, deaths_ours: 0, deaths_enemy: 0, enemy_wand_hits: 0, enemy_wand_misses: 0 };
  const swingDist = [], zapDist = [];
  const lastHit = new Map(), hitsOn = [], resist = {};
  for (const e of events) {
    switch (e.cat) {
      case 'hit_in_player': {
        counts.hits_in_player++; addRange(inc.player, e.hp);
        if (e.held_fire) counts.hits_taken_holding_fire = (counts.hits_taken_holding_fire ?? 0) + 1;
        const a = byAttacker[e.actor ?? '?'] ??= { hits: 0, hp: [0, 0], verbs: {} };
        a.hits++; addRange(a.hp, e.hp); a.verbs[`${e.weapon}: ${e.tier}`] = (a.verbs[`${e.weapon}: ${e.tier}`] ?? 0) + 1;
        const w = byWeapon[e.weapon ?? '?'] ??= { hits: 0, hp: [0, 0], family: e.family ?? null };
        w.hits++; addRange(w.hp, e.hp);
        if (e.tier === 'wand') counts.enemy_wand_hits++;
        break;
      }
      case 'hit_in_monster': counts.hits_in_monster++; addRange(inc.monster, e.hp); break;
      case 'wall_in': counts.walls++; addRange(inc.wall, e.hp); break;
      case 'hit_out': {
        if (!enemy.has(norm(e.target)) && !(e.target && !/^(an?|the)\s/i.test(e.target))) break;
        lastHit.set(`${norm(e.actor)}|${norm(e.target)}`, e);
        hitsOn.push(e);
        if (e.tier === 'wand') counts.wand_hits++; else counts.hits_out++;
        addRange(out.player, e.hp);
        const w = outByWeapon[e.weapon ?? '?'] ??= { hits: 0, tiers: {} };
        w.hits++; w.tiers[e.tier] = (w.tiers[e.tier] ?? 0) + 1;
        break;
      }
      case 'hit_out_monster': counts.hits_out_monster++; break;
      case 'miss_out': if (/wand/.test(e.weapon ?? '')) counts.wand_dodged++; else if (!/^(an?|the)\s/i.test(e.target ?? '')) counts.misses_out++; break;
      case 'miss_in': if (e.weapon === 'vampiric wand') counts.enemy_wand_misses++; else if (/^(an?|the)\s/i.test(e.actor ?? '')) counts.misses_in_monster++; else counts.misses_in_player++; break;
      case 'resist_out': {
        if (/^(an?|the)\s/i.test(e.target ?? '')) break;   // a monster's resistance is not this report's question
        counts.resist_out[e.effect] = (counts.resist_out[e.effect] ?? 0) + 1;
        // The resistance line is POSTED after its hit line (player.kod:4666), so it belongs to the
        // last hit this observer landed on this target.
        const hit = lastHit.get(`${norm(e.actor)}|${norm(e.target)}`);
        const w = hit && e.t - hit.t < 1000 ? `${hit.weapon} (${hit.family ?? hit.tier})` : 'unpaired';
        const r = (resist[e.target] ??= {})[w] ??= {};
        r[e.effect] = (r[e.effect] ?? 0) + 1;
        if (hit) hit.resisted = true;
        break;
      }
      case 'resist_in': counts.resist_in++; break;
      case 'swing': counts.swings++; if (/vetoed/.test(e.text)) counts.swings_vetoed++; if (e.dist != null) swingDist.push(e.dist); break;
      case 'wand_out': counts.wand_zaps++; if (/NO line of sight/.test(e.text)) counts.no_los_zaps++; if (e.dist != null) zapDist.push(e.dist); break;
      case 'refused': {
        refused[e.why] = (refused[e.why] ?? 0) + 1;
        if (/safety/.test(e.why)) counts.safety++;
        if (/karma/.test(e.why)) counts.karma++;
        if (/reach/.test(e.why)) counts.out_of_reach++;
        break;
      }
      case 'effect_in': effectsIn[e.effect] = (effectsIn[e.effect] ?? 0) + 1; break;
      case 'cast_enemy': {
        const k = `${e.actor}`;
        const c = enemyCasts[k] ??= { at_us: 0, self: 0, other: 0, untargeted: 0, sweeps: 0 };
        if (e.spell === 'sweep') { c.sweeps++; counts.sweeps++; }
        else if (e.self) { c.self++; counts.enemy_self_casts++; }
        else if (e.untargeted) { c.untargeted++; counts.enemy_untargeted_casts++; }
        else if (e.target && actors.some(a => a.side === 'ours' && norm(a.name) === norm(e.target))) { c.at_us++; counts.enemy_casts_at_us++; }
        else c.other++;
        break;
      }
      case 'cast_ours': { const sp = /casts (.+?)(?: on | \(|$| ·)/.exec(e.text)?.[1] ?? '?'; ourCasts[sp] = (ourCasts[sp] ?? 0) + 1; break; }
      case 'spell_reply': spellReplies[e.cls] = (spellReplies[e.cls] ?? 0) + 1; break;
      case 'death_ours': counts.deaths_ours++; break;
      case 'death_enemy': counts.deaths_enemy++; break;
    }
  }
  // Hits that drew NO resistance line, per target and weapon: silence is not "neutral" (it is the
  // -20..20 band, or a killing blow), but beside the resisted ones it is the other half of the picture.
  for (const h of hitsOn) if (!h.resisted && h.tier !== 'wand') {
    const w = `${h.weapon} (${h.family ?? h.tier})`;
    const r = (resist[h.target] ??= {})[w] ??= {};
    r['no resistance line'] = (r['no resistance line'] ?? 0) + 1;
  }
  const med = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  return { counts, damage_in: inc, damage_out: out, resist_by_target: resist, by_attacker: byAttacker, by_weapon: byWeapon, out_by_weapon: outByWeapon,
    refused, effects_in: effectsIn, enemy_casts: enemyCasts, our_casts: ourCasts, spell_replies: spellReplies,
    median_swing_dist: med(swingDist), median_zap_dist: med(zapDist),
    zap_dist_over_5: zapDist.filter(d => d > 5).length, swing_dist_over_1_5: swingDist.filter(d => d > 1.5).length };
}

// ------------------------------------------------------------------ the cache and the readers

export const replayDir = (env = process.env) => env.M59_REPLAY_DIR ?? join(pvpDirFor(), 'replays');
const fileFor = id => join(replayDir(), `${String(id).replace(/[^\w.-]/g, '-')}.json`);

/** Our factions by name, from the faction-status cache (m59-faction-status.mjs). */
function readFactions(dir = join(SUBSTRATE(), 'faction-status')) {
  const out = {};
  try {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')); if (j?.character && j.faction) out[norm(j.character)] = j.faction; } catch {}
    }
  } catch {}
  return out;
}

/** The battles in a window. The side files are NOT read here: each replay reads its own slice. */
export function loadWindow({ days = 7, now = Date.now(), stateFile = null, characters = null } = {}) {
  const report = pvpReport({ days, now, stateFile, characters, telemetry: false });
  return { report, since: now - days * 86_400_000, now, stateFile };
}

/** One replay, from the cache when the battle has not moved since it was built. */
export function replayFor(id, { days = 7, stateFile = null, characters = null, rebuild = false, win = null } = {}) {
  win ??= loadWindow({ days, stateFile, characters });
  const b = id === 'latest' ? win.report.battles[0] : win.report.battles.find(x => x.id === id || x.id.includes(id));
  if (!b) return null;
  const f = fileFor(b.id);
  if (!rebuild && existsSync(f)) {
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      if (c.schema === REPLAY_SCHEMA && c.start === b.start && c.end === b.end && c.events?.length) return c;
    } catch {}
  }
  const names = new Set([...(characters ?? []), ...rosterAliases(stateFile ?? '').values(), ...(b.ours ?? []).map(o => o.name)].map(norm));
  const lo = b.start - 45_000, hi = b.end + 30_000;
  const side = p => readSideWindow(p, { since: lo, until: hi });
  const r = buildReplay(b, {
    actions: side('actions'), messages: side('messages'), shots: side('shots'), callouts: side('callouts'),
    trails: readTrails({ since: lo, until: hi }),
    bodies: readLedgerBodies({ since: b.start - 2 * 3_600_000, until: b.end + 2 * 3_600_000 }),
    isOurs: n => names.has(norm(n)), maxHp: readMaxHp(), factions: readFactions(),
  });
  try { mkdirSync(replayDir(), { recursive: true }); writeFileSync(f, JSON.stringify(r)); } catch {}
  return r;
}

/** Battle ids that touched a map, newest first: the geometry page's "PvP here" list. */
export function battlesInMap(num, { days = 30, stateFile = null } = {}) {
  try {
    const r = pvpReport({ days, stateFile, telemetry: false });
    return r.battles.filter(b => b.rooms.includes(Number(num)))
      .map(b => ({ id: b.id, start: b.start, result: b.result, kills: b.kills, our_deaths: b.our_deaths,
        enemies: b.enemies.map(e => e.name) }));
  } catch { return []; }
}

// ------------------------------------------------------------------ the dossier as text

const fmtR = r => r ? `${r[0]}–${r[1] ?? '?'}` : '?';
export function dossierText(rp) {
  const d = rp.dossier, c = d.counts;
  const lines = [];
  lines.push(`${rp.id}  ${rp.result}  K${rp.kills}/D${rp.our_deaths}  ${((rp.end - rp.start) / 1000).toFixed(0)}s  maps ${rp.maps.map(m => `${m.num} ${m.name ?? ''}`).join(', ')}`);
  lines.push(`  actors: ${rp.actors.map(a => `${a.name}[${a.side}${a.faction ? '/' + a.faction : ''}${a.max_hp ? ` ${a.max_hp}hp` : ''}]`).join(' ')}`);
  lines.push(`  damage IN  from players ${fmtR(d.damage_in.player)} HP over ${c.hits_in_player} hits (${c.misses_in_player} misses);  monsters ${fmtR(d.damage_in.monster)} over ${c.hits_in_monster};  walls ${fmtR(d.damage_in.wall)} over ${c.walls}`);
  for (const [k, v] of Object.entries(d.by_attacker)) lines.push(`    by ${k}: ${v.hits} hits ${fmtR(v.hp)} HP — ${Object.entries(v.verbs).map(([x, n]) => `${x} ×${n}`).join(', ')}`);
  lines.push(`  damage OUT to players ${fmtR(d.damage_out.player)} HP: ${c.hits_out} weapon/spell hits, ${c.wand_hits} wand hits; ${c.misses_out} misses, ${c.wand_dodged} wand dodges; resist lines ${JSON.stringify(c.resist_out)}`);
  for (const [k, v] of Object.entries(d.out_by_weapon)) lines.push(`    with ${k}: ${v.hits} — ${JSON.stringify(v.tiers)}`);
  for (const [tg, ws] of Object.entries(d.resist_by_target ?? {})) lines.push(`    ${tg} vs: ${Object.entries(ws).map(([w, r]) => `${w} ${JSON.stringify(r)}`).join('; ')}`);
  if (c.hits_taken_holding_fire) lines.push(`  hits taken while policy held fire: ${c.hits_taken_holding_fire}`);
  lines.push(`  ours sent: ${c.swings} swings (${c.swings_vetoed} vetoed, median ${d.median_swing_dist ?? '?'} sq, ${d.swing_dist_over_1_5} beyond 1.5 sq), ${c.wand_zaps} wand zaps (median ${d.median_zap_dist ?? '?'} sq, ${c.no_los_zaps} without LOS), casts ${JSON.stringify(d.our_casts)}`);
  lines.push(`  spell replies: ${JSON.stringify(d.spell_replies)}`);
  lines.push(`  refused: ${JSON.stringify(d.refused)}`);
  lines.push(`  enemy casts: ${JSON.stringify(d.enemy_casts)}  effects on us: ${JSON.stringify(d.effects_in)}  sweeps ${c.sweeps}, enemy wand ${c.enemy_wand_hits} hit/${c.enemy_wand_misses} miss`);
  lines.push(`  sources: ${JSON.stringify(rp.sources)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const { resolveFleet } = await import('./m59-fleetpath.mjs');
  const { stateFile } = resolveFleet(argv);
  const days = Number(arg('--days', 7));
  const rebuild = argv.includes('--rebuild');
  const win = loadWindow({ days, stateFile });
  if (argv.includes('--list')) {
    for (const b of win.report.battles) console.log(`${b.id}  ${b.result.padEnd(8)} vs ${b.enemies.map(e => e.name).join(', ') || '?'}  maps ${b.rooms.join(',')}`);
  } else if (argv.includes('--battle')) {
    const r = replayFor(arg('--battle', 'latest'), { days, stateFile, rebuild, win });
    if (!r) { console.error('no such battle'); process.exitCode = 1; }
    else if (argv.includes('--json')) console.log(JSON.stringify(r));
    else console.log(dossierText(r));
  } else if (argv.includes('--dossier') || argv.includes('--build-all')) {
    for (const b of win.report.battles) {
      const r = replayFor(b.id, { days, stateFile, rebuild, win });
      if (r && argv.includes('--dossier')) console.log(dossierText(r) + '\n');
      else if (r) console.log(`built ${b.id}: ${r.events.length} events, ${Object.keys(r.tracks).length} bodies`);
    }
  } else {
    console.log('usage: --list | --battle <id|latest> [--json] | --dossier | --build-all   [--days N] [--rebuild] [--fleet prod]');
  }
}
