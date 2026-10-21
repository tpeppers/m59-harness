// m59-pvp-yelp.mjs — THE WOLF THAT YELPS: A LOUD CHARACTER SAYS ONE LINE AS IT FALLS INTO EACH DAMAGE ZONE.
//
// Operator, 2026-10-21: "make these noisy bots send a message ... we're aiming for saying 1 message in each
// corruption zone. It's a bit of an infoleak (the bots will yelp like struck wolves, as per the old saying
// 'the wolf that yelps is the wolf that got hit', making our enemies' targeting easier for them... but we
// know they know, and can also use it for (openly) targeting of protective spells)."
//
// THE ZONES are health thresholds (`thresholds`, percent of max, default 90/65/40/20). Falling to or below
// the Nth is zone N, and zone N is said in Zalgo level N (m59-zalgo.mjs): the first yelp barely corrupted,
// the last one overgrown. ONE LINE PER ZONE PER EPISODE: a hit that drops a body through two zones at once
// says only the deeper one, a body healed back into a zone it already yelped in says nothing, and the episode
// ends when health is back to `reset_at` or above (default 95) -- then the next fall yelps again from zone 1.
//
// ONLY IN A PVP MOMENT, and only for a LOUD character (the same `pvp_loud` / loud combat order as the
// arrival callout, m59-pvp-callout.mjs). Twenty-one characters farming do not narrate every rat bite.
//
// THE LINES are this machine's: substrate/pvp-yelps.json (gitignored; m59-private carries the fleet's),
// falling back to the committed substrate/pvp-yelps.example.json. { "settings": {...}, "zones": { "1": [...],
// ..., "4": [...] } }; each line a string or { "text", "voice" } as for callouts. THE CHARACTER STAYS IN IT:
// with probability `mix_original` the yelp is instead one of the ORIGINAL callouts (a callout line with no
// `tier`) -- "Hi-YAH! Moi does not miss." -- said at the zone's corruption level, so Piggy is still Piggy on
// the way down.
//
// THE LOG. A yelp is a row of kind 'yelp' in callouts-<day>.jsonl beside the arrival callouts; the arrival
// chorus does not count them (chorusVerdict).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCallouts, speaksLine } from './m59-pvp-callout.mjs';
import { DEFAULT_THRESHOLDS, DEFAULT_BUDGET, healthLevel, MAX_LEVEL } from './m59-zalgo.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const YELPS_FILE = (env = process.env) => env.M59_PVP_YELPS ?? join(HERE, 'substrate', 'pvp-yelps.json');
export const YELPS_EXAMPLE = join(HERE, 'substrate', 'pvp-yelps.example.json');

export const DEFAULT_SETTINGS = Object.freeze({
  thresholds: DEFAULT_THRESHOLDS,   // percent of max health; falling to the Nth is zone N
  reset_at: 95,                     // back at or above this, the episode is over
  mix_original: 0.3,                // chance a yelp is an original callout, corrupted to the zone's level
  corrupt_names: false,             // corrupt {enemy}/{me} with the rest of the line
  budget_bytes: DEFAULT_BUDGET,     // UTF-8 bytes; the rest is cut off
});

/** { settings, zones: { 1: lines, ... } } from the file's JSON. Throws on a shape it cannot use. */
export function parseYelps(raw) {
  if (!raw || typeof raw !== 'object' || !raw.zones || typeof raw.zones !== 'object') throw new Error('yelps: expected { "zones": { "1": [...] } }');
  const s = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
  if (!Array.isArray(s.thresholds) || !s.thresholds.length || s.thresholds.length > MAX_LEVEL ||
      s.thresholds.some((t, i) => !(t > 0 && t < 100) || (i && t >= s.thresholds[i - 1])))
    throw new Error(`yelps: thresholds must be 1-${MAX_LEVEL} falling percentages between 0 and 100`);
  if (!(s.reset_at > s.thresholds[0] && s.reset_at <= 100)) throw new Error('yelps: reset_at must be above the first threshold');
  if (!(s.mix_original >= 0 && s.mix_original <= 1)) throw new Error('yelps: mix_original must be 0..1');
  if (!(Number.isSafeInteger(s.budget_bytes) && s.budget_bytes >= 32)) throw new Error('yelps: budget_bytes must be an integer, at least 32');
  const zones = {};
  for (const [k, list] of Object.entries(raw.zones)) {
    const z = Number(k);
    if (!(Number.isSafeInteger(z) && z >= 1 && z <= s.thresholds.length)) throw new Error(`yelps: zone "${k}" is not 1..${s.thresholds.length}`);
    zones[z] = parseCallouts(list);
  }
  return { settings: { ...s, corrupt_names: s.corrupt_names === true }, zones };
}

const cache = { file: null, mtime: 0, yelps: null };
/** The yelps in force: the local file, else the example. Never throws; `error` says why it fell back. */
export function loadYelps({ file = YELPS_FILE(), example = YELPS_EXAMPLE } = {}) {
  let error = null;
  for (const f of [file, example]) {
    try {
      if (!existsSync(f)) continue;
      const mtime = statSync(f).mtimeMs;
      if (cache.file === f && cache.mtime === mtime && cache.yelps) return { ...cache.yelps, file: f, error };
      const yelps = parseYelps(JSON.parse(readFileSync(f, 'utf8')));
      Object.assign(cache, { file: f, mtime, yelps });
      return { ...yelps, file: f, error };
    } catch (e) { error = `${f}: ${e.message}`; }
  }
  return { settings: { ...DEFAULT_SETTINGS }, zones: {}, file: null, error: error ?? 'no yelp lines' };
}

/** One character's episode: which zones it has yelped in since it was last healthy. */
export class YelpTracker {
  constructor() { this.said = new Set(); this.zone = 0; }
  reset() { this.said.clear(); this.zone = 0; }
  /** Health is now `pct`. Returns the zone to yelp in, or null. Dead (0) never yelps. */
  observe(pct, settings = DEFAULT_SETTINGS) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return null;
    if (p >= settings.reset_at) { this.reset(); return null; }
    if (p <= 0) return null;
    const zone = healthLevel(p, settings.thresholds);
    this.zone = zone;
    if (!zone || this.said.has(zone) || [...this.said].some(z => z > zone)) return null;
    for (let z = 1; z <= zone; z++) this.said.add(z);
    return zone;
  }
}

/**
 * The line for a yelp in `zone`: an original callout (`originals`, untiered callout lines) with probability
 * `mix_original`, else one of the zone's own. A line naming {enemy} is skipped when there is no enemy to name.
 * Returns { source: 'yelp'|'original', index, template, voice? } or null.
 */
export function pickYelp(yelps, zone, { originals = [], me = '', enemy = '', recent = [], random = Math.random } = {}) {
  const usable = (line) => speaksLine(line, me) && (enemy || !String(line.text ?? line).includes('{enemy}'));
  const choose = (lines, source) => {
    const idx = (lines ?? []).map((l, i) => i).filter(i => usable(lines[i]) && !(source === 'original' && lines[i].tier));
    if (!idx.length) return null;
    const used = new Set(recent.filter(r => r.source === source && (source === 'original' || r.zone === zone)).map(r => r.index));
    const fresh = idx.filter(i => !used.has(i)), pool = fresh.length ? fresh : idx;
    const index = pool[Math.floor(random() * pool.length) % pool.length], line = lines[index];
    return { source, index, template: typeof line === 'string' ? line : line.text, ...(line.voices ? { voice: line.voices } : {}) };
  };
  const mix = yelps?.settings?.mix_original ?? DEFAULT_SETTINGS.mix_original;
  const first = random() < mix ? 'original' : 'yelp';
  const own = () => choose(yelps?.zones?.[zone], 'yelp'), orig = () => choose(originals, 'original');
  return first === 'original' ? (orig() ?? own()) : (own() ?? orig());
}
