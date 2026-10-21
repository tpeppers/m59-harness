// m59-zalgo.mjs — ZALGO TEXT: A LINE CORRUPTED BY STACKED COMBINING MARKS, AT ONE OF FOUR LEVELS.
//
// Operator, 2026-10-21: callouts and pain yelps in a Cthulhu/Zalgo voice, the corruption "barely kicking
// in" at level 1 and scaling with the damage the speaker has taken. Pure: no I/O, randomness injected.
//
//   level 0  the line as written
//   level 1  ONE word, lightly: one or two of its letters carry a single mark
//   level 2  a quarter to a half of the words, lightly
//   level 3  most words, most letters, a few marks each
//   level 4  every letter, overgrown
//
// THE MARKS DO NOT SURVIVE LATIN-1. M59Client.say encodes Latin-1 by default, which keeps the LOW BYTE of
// anything above U+00FF -- and the low bytes of U+0300..U+036F are digits, letters and control codes, so
// "H̸E" goes out as "H8E". A corrupted line must be said with { encoding: 'utf8' }; `needsUtf8` says
// whether a string has anything Latin-1 cannot carry.
//
// THE BUDGET. The server takes a say of up to LEN_MAX_CLIENT_MSG (6000, blakserv/blakserv.h) and the client
// lets a person type MAXSAY (512, clientd3d/textin.h). A heavy line is several times its length in UTF-8
// bytes, so the result is CUT at `budget` bytes, at a letter boundary, marks and all. The operator asked for
// that rather than a quieter line: "dropping mid-message might be fine/creepy". Never mid-mark, so the cut
// leaves no half character on the wire.
//
// NAMES. `{enemy}` and `{me}` are filled in here, not before, so a caller decides whether a player's name is
// corrupted with the rest of the line (`corruptNames`) or left readable.

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCharCode(a + i));
export const MARKS_UP = [
  ...'̍̎̄̅̿̑̆̐͒͗͑̇̈̊͂̓̈́',
  ...'͊͋͌̃̂̌͐̀́̋̏̒̓̔̽̉̾',
  ...'͛͆̚', ...range(0x0363, 0x036f)];
export const MARKS_MID = [...'̴̵̶̡̢̧̨̛̀́̕͘͏̸̷͜͟͢͝͞͠͡'];
export const MARKS_DOWN = [
  ...'̖̗̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭',
  ...'̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎͓ͅ',
  ...'͔͕͖͙͚̣'];
const IS_MARK = /[̀-ͯ҉]/;

export const MAX_LEVEL = 4;
export const DEFAULT_BUDGET = 400;

// Per level: share of words touched, share of letters in a touched word, and the most marks of each kind.
const LEVELS = {
  1: { up: 1, mid: 0, down: 1, letters: 0.35 },
  2: { words: [0.25, 0.5], up: 1, mid: 0, down: 1, letters: 0.5 },
  3: { words: [0.7, 0.9], up: 2, mid: 1, down: 2, letters: 0.7 },
  4: { words: [1, 1], up: 5, mid: 1, down: 5, letters: 1 },
};

export const clampLevel = n => Math.max(0, Math.min(MAX_LEVEL, Math.round(Number(n) || 0)));
export const needsUtf8 = s => /[^\x00-\xff]/.test(String(s ?? ''));
export const utf8Bytes = s => Buffer.byteLength(String(s ?? ''), 'utf8');

/** Cut `s` to at most `budget` UTF-8 bytes, at a letter boundary: a letter goes with all of its marks. */
export function cutToBudget(s, budget = DEFAULT_BUDGET) {
  const text = String(s ?? '');
  if (utf8Bytes(text) <= budget) return { text, truncated: false };
  let out = '', used = 0, cluster = '';
  for (const ch of text) {
    if (cluster && !IS_MARK.test(ch)) {
      const b = utf8Bytes(cluster);
      if (used + b > budget) return { text: out, truncated: true };
      out += cluster; used += b; cluster = '';
    }
    cluster += ch;
  }
  const b = utf8Bytes(cluster);
  return used + b > budget ? { text: out, truncated: true } : { text: out + cluster, truncated: false };
}

/** Corrupt one word's letters. `spec` from LEVELS; `random` in [0,1). */
function corruptWord(word, spec, random) {
  const letters = [...word].map((ch, i) => /[\p{L}\p{N}]/u.test(ch) ? i : -1).filter(i => i >= 0);
  if (!letters.length) return word;
  const chosen = new Set(letters.filter(() => random() < spec.letters));
  // Level 1 is ONE or two letters of the one word, never none of them.
  if (!chosen.size) chosen.add(letters[Math.floor(random() * letters.length) % letters.length]);
  const pick = list => list[Math.floor(random() * list.length) % list.length];
  const n = max => max ? 1 + Math.floor(random() * max) % max : 0;
  return [...word].map((ch, i) => {
    if (!chosen.has(i)) return ch;
    let out = ch;
    // A light level puts one mark on a letter, above OR below; heavier ones stack every kind.
    if (spec.up === 1 && spec.down === 1 && !spec.mid) return out + pick(random() < 0.5 ? MARKS_UP : MARKS_DOWN);
    for (let k = n(spec.up); k--;) out += pick(MARKS_UP);
    if (spec.mid && random() < 0.5) out += pick(MARKS_MID);
    for (let k = n(spec.down); k--;) out += pick(MARKS_DOWN);
    return out;
  }).join('');
}

/**
 * Corrupt a line template at `level`, filling `{enemy}`/`{me}` from `vars`.
 * Returns { text, level, truncated, utf8 } -- `utf8` true when the text must go out as UTF-8.
 */
export function zalgo(template, level, { vars = {}, corruptNames = false, random = Math.random, budget = DEFAULT_BUDGET } = {}) {
  const lv = clampLevel(level), spec = LEVELS[lv];
  // Tokens: words, the spaces between them, and the {enemy}/{me} slots, kept apart from the words.
  const tokens = String(template ?? '').split(/(\{enemy\}|\{me\}|\s+)/).filter(t => t !== '');
  const fill = t => t === '{enemy}' ? String(vars.enemy ?? '') : t === '{me}' ? String(vars.me ?? '') : t;
  const slot = t => t === '{enemy}' || t === '{me}';
  const words = tokens.map((t, i) => (/^\s+$/.test(t) || (slot(t) && !corruptNames) || !fill(t)) ? -1 : i).filter(i => i >= 0);
  let touched = new Set();
  if (spec && words.length) {
    if (lv === 1) touched.add(words[Math.floor(random() * words.length) % words.length]);
    else {
      const [lo, hi] = spec.words, share = lo + random() * (hi - lo);
      const want = Math.max(1, Math.round(share * words.length));
      const pool = [...words];
      while (touched.size < want && pool.length) touched.add(pool.splice(Math.floor(random() * pool.length) % pool.length, 1)[0]);
    }
  }
  const out = tokens.map((t, i) => touched.has(i) ? corruptWord(fill(t), spec, random) : fill(t)).join('').replace(/\s+/g, ' ').trim();
  const { text, truncated } = cutToBudget(out, budget);
  return { text, level: lv, truncated, utf8: needsUtf8(text) };
}

/** The corruption level for a body at `pct` health: 0 at full, 1..4 as it falls through `thresholds`. */
export const DEFAULT_THRESHOLDS = [90, 65, 40, 20];
export function healthLevel(pct, thresholds = DEFAULT_THRESHOLDS) {
  if (pct == null || !Number.isFinite(Number(pct))) return 0;
  let level = 0;
  thresholds.forEach((t, i) => { if (Number(pct) <= t) level = i + 1; });
  return clampLevel(level);
}
