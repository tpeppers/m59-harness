// FACTION INTEL — WHAT THE FLEET HAS OVERHEARD ABOUT THE STRUGGLE, AND WHAT IT IMPLIES.
//
// The server never tells a client how powerful a faction is. `Parliament` (util/parlia.kod)
// keeps four raw point totals and nothing reads them out over the wire. What it DOES do is
// leak them, a sentence at a time, to anyone standing in the right place:
//
//   flag claims     "All hail X, who has successfully claimed <place> in the name of <liege>!"
//                   — broadcast; the territory game is 1000 points split by flags held
//                   (territry.kod GetPoints, 36 flag rooms in plFlagRIDs).
//   claim attempts  "X has bravely staked a claim to <place> in the name of <liege>!"
//   token returns   "All hail X who has returned <token> to the Meridian Council." — broadcast
//                   (token.kod). The councilor's own thanks names the faction it now leans to
//                   (council.kod CheckWhyWanted); the token game is 1000 points split by
//                   councilor loyalty over five councilors (tokngame.kod GetPoints).
//   councilor news  a liege's "<councilor> is suspected to be a <strength> believer in <cause>."
//   rumours         a townsperson's "I've heard that the Duke and his servants now wield
//                   unsurpassable influence…" — the power BAND itself, one of five (parlia.kod).
//   power shifts    "You sense a shift in the balance of power at the Royal Court." — a band
//                   changed somewhere; it does not say whose.
//   personal hints  1-in-101 on each use, "Techniques learned from <liege> help guide your
//                   attack." (up) or "If <liege> were more favored, you might learn ways to hit
//                   more often." (down) — the only MEASUREMENT of a character's own bonus.
//   shield rank     "Your rank within <army> is: <title>." — read by max-faction-shield.mjs.
//
// Each is prose said once, so it is caught off the event stream on its way past or it is
// lost — the bank-balance pattern. Twenty-one keeper processes hear the same broadcast, so the
// store is APPEND-ONLY JSONL (one short line per sighting, no read-modify-write to race) and
// the reader folds duplicates. Player names in broadcasts are NOT stored: the board is about
// factions, and a claimer's name is a stranger's.
//
// Everything this module infers is an ESTIMATE from what was overheard, and says how much it
// could not see: an unseen flag is unknown, not neutral.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored to the checkout, not the cwd: keeper processes, the broker and a fleetscript runner
// must all append to the same file.
export const INTEL_FILE = join(fileURLToPath(new URL('..', import.meta.url)), 'substrate', 'faction-intel.jsonl');
export const FACTIONS = Object.freeze(['duke', 'princess', 'rebel', 'neutral']);

// territry.kod: 24 wilderness/town-edge RIDs plus 12 more consed on (seven wilderness, five
// town flags). Every one is counted into plFlagCounts.
export const FLAG_COUNT = 36;
export const COUNCILORS = Object.freeze(['Alzahakar', 'Bei Naq', 'Cylill', 'Drechx', 'Esseldi']);
export const GAME_POINTS = 1000;            // each of the two games, piTotalPoints
export const BALANCE_FACTOR = 25;           // parlia.kod piBalanceFactor

// parlia.kod FigurePowerFromCount; blakston.khd FACTION_STRONGLY_IN = 5 .. STRONGLY_OUT = 1.
export const POWER_BANDS = Object.freeze({
  5: 'strongly in power', 4: 'in power', 3: 'normal', 2: 'out of power', 1: 'strongly out of power',
});

const clean = s => String(s ?? '').replace(/~[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();

const LIEGE = [
  [/Duke Akardius|the Duke\b|Duke's/i, 'duke'],
  [/Princess Kateriina|Princess'/i, 'princess'],
  [/rebel forces|Jonas|rebel/i, 'rebel'],
  [/unfactioned/i, 'neutral'],
];
const liegeOf = s => LIEGE.find(([re]) => re.test(String(s ?? '')))?.[1] ?? null;

// parlia.kod rumour suffixes -> band
const RUMOUR_BANDS = [
  ['wield unsurpassable influence', 5], ['show considerable influence', 4],
  ['back to normal levels', 3], ["just don't seem to have much influence", 2],
  ['completely lack any influence', 1],
];
const RUMOUR_PREFACE = [
  [/I've heard that the Duke and his servants now/i, 'duke'],
  [/lately Princess Kateriina and her followers/i, 'princess'],
  [/The rumors about Jonas say his rebels/i, 'rebel'],
  [/Currently at the Court, the unfactioned/i, 'neutral'],
];

// tokngame.kod parl_factioned_* — the "self" forms are unique per faction, so the speaker's
// own faction is never needed to read them.
const COUNCIL_CAUSE = [
  [/the trivial causes of the Duke|our causes/i, 'duke'],
  [/the misguided hopes of Princess Kateriina|our desires/i, 'princess'],
  [/the harmful rebellion of Jonas|our fight for freedom/i, 'rebel'],
  [/the foolishness of factions|Shal'ille's guidance instead of our ideas/i, 'neutral'],
];
// council.kod con_*_delivered_rsc
const COUNCIL_LEAN = [
  [/matters which concern the Duke/i, 'duke'],
  [/favor on the Princess Kateriina's ideas/i, 'princess'],
  [/look upon rebellion as a sign of good change/i, 'rebel'],
  [/as impartial at the court as ye/i, 'neutral'],
];

// parlia.kod parliament_*_up / _down. The %s is the liege's name.
const BONUS_LINES = [
  ['price', true, /association with (.+?) gets you the best possible price/i],
  ['damage', true, /Techniques learned from (.+?) help your attack do more damage/i],
  ['hit', true, /Techniques learned from (.+?) help guide your attack/i],
  ['learn', true, /Inspired by (.+?), you take a moment to study/i],
  ['spell', true, /Techniques learned from (.+?) give your spells more power/i],
  ['defense', true, /(.+?)'s techniques help you to defend yourself/i],
  ['regen', true, /(.+?)'s guidance helps you to recuperate faster/i],
  ['vigor', true, /(.+?)'s guidance helps you retain some of your vigor/i],
  ['price', false, /if (.+?) were more favored, merchant's prices/i],
  ['damage', false, /if (.+?) were more favored, you would be shown ways to do more damage/i],
  ['hit', false, /If (.+?) were more favored, you might learn ways to hit/i],
  ['learn', false, /if (.+?) were more favored, you would learn faster/i],
  ['spell', false, /If (.+?) were more favored, your spells would have more power/i],
  ['defense', false, /If (.+?) were more favored, you could defend yourself/i],
  ['regen', false, /if (.+?) were more favored, you could recuperate faster/i],
  ['vigor', false, /if (.+?) were more favored, you use your vigor slower/i],
];

const RANK_RE = /Your rank within (.+?) is: (.+?)\./i;

/**
 * One line of prose -> one typed observation, or null. `speaker` is the name on a `said`
 * event (a councilor, a liege, a townsperson) and is only consulted for councilor thanks.
 */
export function parseFactionLine(text, { speaker = null } = {}) {
  const t = clean(text);
  if (!t) return null;
  let m;
  if (/sense a shift in the balance of power at the Royal Court/i.test(t)) return { type: 'power_shift' };
  if ((m = /who has successfully claimed (.+?) in the name of (.+?)!/i.exec(t)))
    return { type: 'flag', place: m[1].trim(), holder: liegeOf(m[2]) };
  if ((m = /has bravely staked a claim to (.+?) in the name of (.+?)!/i.exec(t)))
    return { type: 'claim_attempt', place: m[1].trim(), faction: liegeOf(m[2]) };
  if ((m = /has valiantly defended (.+?) against/i.exec(t)))
    return { type: 'claim_failed', place: m[1].trim() };
  if ((m = /who has returned (.+?) to the Meridian Council/i.exec(t)))
    return { type: 'token_returned', token: m[1].trim().replace(/^(the|a|an) /i, '') };
  if ((m = /^(?:Thank you\. You have done me a great service\.)/i.exec(t))) {
    const lean = COUNCIL_LEAN.find(([re]) => re.test(t))?.[1];
    const councilor = COUNCILORS.find(c => String(speaker ?? '').includes(c)) ?? null;
    if (lean) return { type: 'councilor', councilor, faction: lean, source: 'thanks' };
  }
  if ((m = /(?:^|\s)(\S.*?) is suspected to be a (weak|strong|dedicated) believer in (.+?)\.?$/i.exec(t))) {
    const councilor = COUNCILORS.find(c => m[1].includes(c)) ?? null;
    const faction = COUNCIL_CAUSE.find(([re]) => re.test(m[3]))?.[1] ?? null;
    if (councilor && faction) return { type: 'councilor', councilor, faction, strength: m[2].toLowerCase(), source: 'liege' };
  }
  const pre = RUMOUR_PREFACE.find(([re]) => re.test(t));
  if (pre) {
    const band = RUMOUR_BANDS.find(([s]) => t.toLowerCase().includes(s.toLowerCase()))?.[1];
    if (band) return { type: 'rumour', faction: pre[1], band };
  }
  for (const [kind, up, re] of BONUS_LINES) {
    if ((m = re.exec(t))) return { type: 'bonus', kind, up, faction: liegeOf(m[1]) };
  }
  if ((m = RANK_RE.exec(t))) return { type: 'rank', army: m[1].trim(), title: m[2].trim() };
  return null;
}

// ------------------------------------------------------------------ the log

const lastBonus = new Map();          // per process: one bonus sighting per kind per 10 min
const BONUS_THROTTLE_MS = 10 * 60_000;

/** Append one observation. Never throws: bookkeeping must not cost an event. */
export function recordIntel(obs, { file = INTEL_FILE, at = Date.now(), server = null,
                                   character = null, agent = null } = {}) {
  if (!obs) return null;
  try {
    if (obs.type === 'bonus') {
      const key = `${character}|${obs.kind}|${obs.up}`;
      if (at - (lastBonus.get(key) ?? 0) < BONUS_THROTTLE_MS) return null;
      lastBonus.set(key, at);
    }
    const row = { at, ...(server ? { server } : {}), ...(character ? { character } : {}),
                  ...(agent ? { agent } : {}), ...obs };
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + '\n');
    return row;
  } catch { return null; }
}

/** Parse and record in one step; what a keeper's event hook calls. */
export function noteFactionLine(ev, ctx = {}) {
  const obs = parseFactionLine(ev?.text, { speaker: ev?.name ?? null });
  return obs ? recordIntel(obs, { ...ctx, at: ev?.at ?? Date.now() }) : null;
}

export function readIntelRows({ file = INTEL_FILE, server = null, sinceMs = null, now = Date.now() } = {}) {
  const path = resolve(file);
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (server && r.server && r.server !== server) continue;
      if (sinceMs && now - r.at > sinceMs) continue;
      rows.push(r);
    } catch { /* a torn last line is not a reason to lose the rest */ }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** Fold the log into the latest known state. Later sightings win. */
export function foldIntel(rows) {
  const s = { flags: {}, councilors: {}, rumours: {}, shifts: [], tokens: [], attempts: [],
              bonuses: {}, ranks: {} };
  for (const r of rows) {
    switch (r.type) {
      case 'flag': if (r.place && r.holder) s.flags[r.place] = { holder: r.holder, at: r.at }; break;
      case 'claim_attempt': s.attempts.push({ place: r.place, faction: r.faction, at: r.at }); break;
      case 'councilor': if (r.councilor) s.councilors[r.councilor] = { faction: r.faction, strength: r.strength ?? null, at: r.at, source: r.source }; break;
      case 'rumour': s.rumours[r.faction] = { band: r.band, at: r.at }; break;
      case 'power_shift': if (!s.shifts.length || r.at - s.shifts.at(-1) > 60_000) s.shifts.push(r.at); break;
      case 'token_returned': if (!s.tokens.some(x => x.token === r.token && Math.abs(x.at - r.at) < 60_000)) s.tokens.push({ token: r.token, at: r.at }); break;
      case 'bonus': {
        const who = r.character ?? r.agent; if (!who) break;
        const b = (s.bonuses[who] ??= {});
        const k = (b[r.kind] ??= { up: 0, down: 0, last: null, last_at: null });
        k[r.up ? 'up' : 'down']++; k.last = r.up ? 'up' : 'down'; k.last_at = r.at;
        break;
      }
      case 'rank': {
        const who = r.character ?? r.agent; if (!who) break;
        s.ranks[who] = { title: r.title, army: r.army ?? null, min: r.min ?? null, max: r.max ?? null, at: r.at };
        break;
      }
    }
  }
  return s;
}

// ------------------------------------------------------------------ the estimate

/** parlia.kod FigurePowerFromCount, with the balance taken from the total. */
export function powerBand(points, total = 2 * GAME_POINTS, neutral = false) {
  const balance = Math.floor(total * (neutral ? 100 - 3 * BALANCE_FACTOR : BALANCE_FACTOR) / 100);
  if (!balance) return 3;
  if (points >= 2 * balance) return 5;
  if (points >= Math.floor(3 * balance / 2)) return 4;
  if (points >= balance) return 3;
  if (points >= Math.floor(balance / 2)) return 2;
  return 1;
}

/** parlia.kod CalcFactionBonus: the power half, as a percent of the base (-10..150). */
export function powerContribution(points, total = 2 * GAME_POINTS, neutral = false) {
  const balance = Math.floor(total * (neutral ? 100 - 3 * BALANCE_FACTOR : BALANCE_FACTOR) / 100);
  if (!balance) return 100;
  const p = points <= balance ? Math.floor(110 * points / balance) - 10
                              : 100 + Math.floor(50 * (points - balance) / balance);
  return Math.max(-10, Math.min(150, p));
}

/**
 * Each faction's points as a RANGE: low counts only what was seen, high also hands it every
 * flag and councilor nobody has reported. A rumour, when heard, is the server's own band and
 * is shown beside the estimate rather than blended into it.
 */
export function estimatePower(state, { flagCount = FLAG_COUNT } = {}) {
  const flags = Object.values(state.flags);
  const seenFlags = Math.min(flagCount, flags.length);
  const unseenFlags = flagCount - seenFlags;
  const cons = Object.values(state.councilors);
  const unseenCons = COUNCILORS.length - cons.length;
  const out = {};
  for (const f of FACTIONS) {
    const fl = flags.filter(x => x.holder === f).length;
    const co = cons.filter(x => x.faction === f).length;
    const territory = [fl, fl + unseenFlags].map(n => Math.floor(n * GAME_POINTS / flagCount));
    const tokens = [co, co + unseenCons].map(n => Math.floor(n * GAME_POINTS / COUNCILORS.length));
    const points = [territory[0] + tokens[0], territory[1] + tokens[1]];
    const neutral = f === 'neutral';
    out[f] = {
      flags: fl, councilors: co, territory, tokens, points,
      band: points.map(p => powerBand(p, 2 * GAME_POINTS, neutral)),
      contribution: points.map(p => powerContribution(p, 2 * GAME_POINTS, neutral)),
      rumour: state.rumours[f] ?? null,
    };
  }
  return { factions: out, seen_flags: seenFlags, unseen_flags: unseenFlags,
           seen_councilors: cons.length, unseen_councilors: unseenCons };
}

// ------------------------------------------------------------------ what a member gets

// parlia.kod "Effects Part". base = what CalcFactionBonus scales (100% at the balance point,
// 150% at most); flat = what a NON-intriguing member gets instead (PFLAG_INTRIGUING needs the
// PK switch on AND 40 base max health or a level-5 spell, player.kod PlayerIsIntriguing);
// fixed = not power-scaled at all. `applies` says which factions get the kind and on what.
export const BENEFITS = Object.freeze([
  { kind: 'spell', label: 'spell power', unit: '', base: 10, flat: 3,
    applies: { duke: 'Qor, Riija, Kraanan spells', princess: "Shal'ille, Faren, Jala spells", rebel: 'every school', neutral: 'every school' } },
  { kind: 'learn', label: 'learn chance', unit: '', base: 10, flat: 2,
    applies: { duke: 'Qor, Riija, Kraanan spells', princess: "Shal'ille, Faren, Jala spells", rebel: 'weapon skills, not spells', neutral: 'everything' } },
  { kind: 'hit', label: 'to-hit', unit: '', base: 100, flat: 50,
    applies: { rebel: 'every attack', neutral: 'every attack' } },
  { kind: 'defense', label: 'defense', unit: '', base: 200, flat: 50,
    applies: { princess: 'always', neutral: 'always' } },
  { kind: 'regen', label: 'regen', unit: ' ms faster', base: 700, flat: 200,
    applies: { princess: 'mana only', rebel: 'health only', neutral: 'health and mana' } },
  { kind: 'vigor', label: 'vigor use', unit: '% less', base: 30, flat: 5,
    applies: { duke: 'always', neutral: 'always' } },
  { kind: 'price', label: 'shop prices', unit: '% better', fixed: 5, applies: { princess: 'buying and selling' } },
  { kind: 'damage', label: 'damage', unit: ' extra', fixed: 2, applies: { rebel: 'every hit' } },
  { kind: 'murderer', label: 'murderer may shop', fixed: null, applies: { duke: 'lawful merchants serve a murderer' } },
]);

/**
 * What one benefit is worth to a member of `faction`, given a power contribution percent
 * (-10..150) and a membership percent (25..100, unknown to us — the server counts members
 * itself). Returns null when the faction gets nothing of this kind.
 */
export function benefitValue(b, faction, { contribution = 100, members = 100, intriguing = true } = {}) {
  if (!b.applies[faction]) return null;
  if (b.base == null) return { value: b.fixed, max: b.fixed, fixed: true };
  if (!intriguing) return { value: b.flat, max: b.flat, flat: true };
  let v = contribution > 0 ? Math.floor(b.base * contribution * members / 10000)
                           : Math.floor(b.base * contribution / 100);
  let max = Math.floor(b.base * 150 / 100);
  if (faction === 'neutral') { v = Math.max(0, Math.floor(v / 4)); max = Math.floor(max / 4); }
  return { value: v, max };
}
