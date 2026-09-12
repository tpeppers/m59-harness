#!/usr/bin/env node
// IS THIS CHARACTER ACTUALLY EARNING ANYTHING, AND FOR HOW LONG HAS IT NOT BEEN?
//
// The hardest question to answer about this fleet is not "is it broken". Broken is loud. It is
// "is this one WORKING" — because a character that has stopped earning looks exactly like a
// healthy one on every surface there is. Sweetums on 2026-09-12 was in game, in the room his
// doctrine named, hunting the quarry it named, at full health, inside his engagement ceiling,
// swinging, with a green row on every board. His keeper's own counter said `broke off without
// a landed hit or a kill` NINE HUNDRED AND NINETEEN TIMES RUNNING and nothing on any board
// said so. It took hours to find. This is that question as one command.
//
// ---------------------------------------------------------------- why the fleet row cannot answer
//
// `kills_30m` exists and is not this. It reads 0 for a character between respawns and 0 for one
// that has killed nothing since yesterday, and those need different actions. What is missing is
// the DURATION: not "is it zero now" but "since when", which is the only form of the number an
// operator can act on.
//
// `kills` on the row is worse than useless for it — CLAUDE.md's own warning — because it lives
// on the keeper and keepers restart about once a minute. So this reads the LEDGER, which is
// append-only and outlives them.
//
// ---------------------------------------------------------------- the trap this file exists to remove
//
// AN EVENT NAMES ITS CHARACTER IN ONE OF TWO FIELDS AND READING THE WRONG ONE SILENTLY ANSWERS
// ZERO.
//
// `killed` rows carry `agent: "t11"` and `character: "Sweetums"`. `died` and `level_lost` rows
// carry `character` and NO agent at all. A filter written as `r.agent || r.character` therefore
// takes the AGENT when there is one — so testing it against a character name matches nothing,
// and a character with forty-one kills reports zero.
//
// That is not hypothetical and it is not somebody else's mistake: I did it on 2026-09-12, while
// diagnosing this very character, and reported "0 kills in 12 hours" to an operator and to
// another session. The real number was seventeen. The conclusion happened to survive — the
// keeper's own stall counter and the ability list both said the same thing independently — but
// the headline figure was an artefact of my own filter, and it read exactly like a measurement.
//
// So identity is resolved ONCE, here, against BOTH fields, and every count in this file goes
// through it. That is the whole reason this is a tool and not a `node -e`.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HOUR = 3600_000;

/**
 * DOES THIS ROW BELONG TO THIS CHARACTER? Both spellings, every time.
 *
 * Exported because the next person to answer a question off these ledgers must not re-derive
 * it — re-deriving it is precisely what went wrong.
 */
export const rowIsFor = (row, who) => {
  const want = String(who ?? '').trim().toLowerCase();
  if (!want) return false;
  return String(row?.agent ?? '').trim().toLowerCase() === want ||
         String(row?.character ?? '').trim().toLowerCase() === want;
};

/**
 * AGENT HANDLE -> CHARACTER NAME, LEARNED FROM THE ROWS THEMSELVES.
 *
 * Most rows carry both, so the mapping is in the ledger and never has to be guessed or read
 * from a roster this tool has no business opening. It is needed because a HANDFUL of rows —
 * `wedge_gave_up` is one — put the handle in the `character` field, so a naive list of
 * distinct `character` values yields both "Kermit" and "t1" and reports the same body twice
 * with different numbers. Exactly the same confusion between the two names that produced the
 * false zero this file's header is about, arriving from the other direction.
 */
export function agentNames(rows) {
  const map = new Map();
  for (const r of rows) {
    const a = String(r?.agent ?? '').trim();
    const c = String(r?.character ?? '').trim();
    if (a && c && !/^(t\d+|hk\d+)$/i.test(c)) map.set(a.toLowerCase(), c);
  }
  return map;
}

/** The real character names in these rows, handles folded into them. */
export function charactersIn(rows) {
  const byAgent = agentNames(rows);
  const names = new Set();
  for (const r of rows) {
    const c = String(r?.character ?? '').trim();
    if (!c) continue;
    names.add(/^(t\d+|hk\d+)$/i.test(c) ? (byAgent.get(c.toLowerCase()) ?? c) : c);
  }
  return [...names].sort();
}

/** Every ledger row for a fleet, newest file last. */
export function ledger(fleet = 'prod', { root = 'substrate/history', days = 3 } = {}) {
  const dir = join(root, fleet);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => /^fleet-.*\.jsonl$/.test(f)).sort().slice(-days);
  const rows = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* a torn last line is normal */ }
    }
  }
  return rows;
}

/**
 * WHAT ONE CHARACTER HAS EARNED, AND WHAT IT HAS LOST.
 *
 * `net_levels` is the number this was built for. A character that dies a lot and climbs back
 * is a different emergency from one whose max health only ever goes down, and nothing on any
 * board distinguishes them — both show deaths.
 *
 * A `level_lost` ROW IS A SAMPLED DIFF, NOT A DEATH, AND THAT DECIDES HOW IT MAY BE USED.
 *
 * There is exactly one emitter (m59-ledger.mjs:186) and it consults nothing about dying:
 *
 *     if (now.level !== was.level)
 *       recordEvent(name, now.level > was.level ? 'level_up' : 'level_lost', {from, to, room})
 *
 * Level IS base max health, so the loss is real — but the TIMESTAMP is when the sampler
 * noticed, not when it happened. Measured across 718 rows: 63% have a death within 5 minutes,
 * 80% within an hour, and the median lag is 5.0 minutes, which is exactly the sample interval.
 * The row is systematically one poll behind. The p90 is 704 minutes, because a character
 * nobody polls — keeper down, logged out — has its diff land whenever sampling resumes.
 *
 * TWO THINGS THAT WOULD HAVE MADE THIS UNUSABLE AND ARE MEASURED NOT TO BE. Sampler flicker:
 * zero — not one level_lost is followed by a level_up within five minutes, so these are real
 * losses and not noise bouncing back. Fleet-wide recomputation: two windows in the whole
 * ledger have four or more characters, 10 rows, 4% — not the story either. 7% of rows have no
 * death within six hours and are unexplained; candidates are a `died` row that failed to
 * write, a max-health change from something other than death, or a long unsampled gap.
 *
 * SO: COUNT THEM PER CHARACTER, NEVER JOIN THEM BY TIME. `levels_lost` and `levels_gained`
 * are whole-ledger totals on purpose — a row landing one poll late still lands on the right
 * character with the right magnitude, so netting survives the lag. Putting them in a window
 * would not: a death near midnight writes its row into the NEXT day's file, which is exactly
 * what produced per-day death:loss ratios above 1.0 and sent two sessions looking for a second
 * source that does not exist. Do not correlate a level loss with what the character was doing
 * when the row was written, and do not attribute one to a window narrower than a few hours.
 * `deaths_by_window` IS windowed, and may be, because `died` rows are written in real time.
 *
 * Peer measurement, 2026-09-12.
 */
export function earningFor(rows, who, { now = Date.now(), windows = [1, 6, 12, 24] } = {}) {
  const mine = rows.filter(r => rowIsFor(r, who));
  const of = kind => mine.filter(r => r.kind === kind).sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  const kills = of('killed');
  const deaths = of('died');
  const lost = of('level_lost');
  const up = of('level_up');

  const inWindow = (list, h) => list.filter(r => now - (r.t ?? 0) < h * HOUR).length;
  const lastKill = kills[0]?.t ?? null;

  return {
    character: who,
    seen: mine.length,
    kills_by_window: Object.fromEntries(windows.map(h => [h + 'h', inWindow(kills, h)])),
    deaths_by_window: Object.fromEntries(windows.map(h => [h + 'h', inWindow(deaths, h)])),
    last_kill_iso: lastKill ? new Date(lastKill).toISOString() : null,
    // Null, not Infinity, and not 0. "Never killed anything in this window" and "killed
    // something a moment ago" must not both round to a number an alert can compare.
    hours_since_kill: lastKill ? +((now - lastKill) / HOUR).toFixed(2) : null,
    // WHOLE-LEDGER TOTALS, NOT WINDOWED, AND THAT IS NOT AN OVERSIGHT — see the note above.
    // These rows are sampled diffs whose timestamps lag the event by a poll (median 5.0m, p90
    // 704m), so they are sound per character and unsound per time window.
    levels_lost: lost.length,
    levels_gained: up.length,
    net_levels: up.length - lost.length,
    // The level the ledger last saw it at, from either direction.
    level_now: (up[0]?.t ?? 0) > (lost[0]?.t ?? 0) ? (up[0]?.to ?? null) : (lost[0]?.to ?? null),
  };
}

/**
 * THE TWO VERDICTS WORTH WAKING SOMEBODY FOR.
 *
 * Deliberately only two. A report that flags nine things is a report nobody reads, and both of
 * these were real on this fleet on the day they were written.
 */
export function verdicts(e, { idleHours = 6, window = 12 } = {}) {
  const out = [];
  // ONE THRESHOLD, NOT TWO. This was written as "no kills in `window` AND quiet for
  // `idleHours`", and the two contradict: with the default 12h window, a kill four hours ago
  // puts the window count at 1, so the AND is false and `idleHours` can never fire however
  // low it is set. The parameter was dead on arrival and the report would have stayed quiet
  // about a character that had stopped half a day ago. Caught by this file's own test.
  //
  // The verdict is about DURATION, which is the whole reason the tool exists, so duration is
  // the only thing it reads. `window` stays for the displayed counts and for the sentence.
  const killsInWindow = e.kills_by_window[window + 'h'] ?? 0;
  // ZERO-YIELD is about DURATION, which is the whole point — see the header. A character that
  // has never killed anything in the ledger reads `hours_since_kill: null`, and that is the
  // worst case rather than an absent one.
  if (e.hours_since_kill === null || e.hours_since_kill >= idleHours)
    out.push({ code: 'ZERO_YIELD',
               why: e.hours_since_kill === null
                 ? `no kill anywhere in the ledger — it has earned nothing at all`
                 : `last kill ${e.hours_since_kill}h ago (${killsInWindow} in ${window}h)`,
               remedy: 'it is in the wrong room, or it cannot hurt what is in this one. ' +
                       'Check the quarry level against its proficiency, not just the ceiling' });
  // RATCHET. Not "it died" — it dying is ordinary and the operator has said so. It is that max
  // health is a one-way street: the band that selects a small character sends it down the road
  // that makes it smaller, and nothing in the system has an opinion about the cost of the trip.
  if (e.net_levels < 0)
    out.push({ code: 'RATCHET',
               why: `${e.levels_lost} level(s) lost against ${e.levels_gained} gained — ` +
                    `net ${e.net_levels}. Max health only goes down for this one`,
               remedy: 'the deaths are the trip, not the destination: group them by room ' +
                       'before changing the station' });
  return out;
}

// ---------------------------------------------------------------- cli
const isMain = !!process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const fleet = flag('--fleet', process.env.M59_FLEET || 'prod');
  const window = Number(flag('--window', 12));
  const idleHours = Number(flag('--idle-hours', 3));
  const only = flag('--character', null);

  const rows = ledger(fleet, { days: Number(flag('--days', 3)) });
  if (!rows.length) { console.log(`no ledger under substrate/history/${fleet}/`); process.exit(0); }

  const names = charactersIn(rows);
  const wanted = only ? names.filter(n => n.toLowerCase() === only.toLowerCase()) : names;

  console.log(`${fleet} — kills and levels from the ledger, ${window}h window\n`);
  console.log('character      k1h  k6h  k12h k24h  since   d24h  lost  up   net  flags');
  const flagged = [];
  for (const n of wanted) {
    const e = earningFor(rows, n, { windows: [1, 6, 12, 24] });
    const v = verdicts(e, { idleHours, window });
    if (v.length) flagged.push({ n, e, v });
    console.log(
      String(n).slice(0, 14).padEnd(14),
      String(e.kills_by_window['1h']).padStart(3),
      String(e.kills_by_window['6h']).padStart(4),
      String(e.kills_by_window['12h']).padStart(4),
      String(e.kills_by_window['24h']).padStart(4),
      (e.hours_since_kill === null ? 'never' : e.hours_since_kill + 'h').padStart(7),
      String(e.deaths_by_window['24h']).padStart(5),
      String(e.levels_lost).padStart(5),
      String(e.levels_gained).padStart(4),
      String(e.net_levels > 0 ? '+' + e.net_levels : e.net_levels).padStart(5),
      '  ' + v.map(x => x.code).join(' '));
  }
  if (flagged.length) {
    console.log('\n---- what to do about it ----');
    for (const { n, v } of flagged)
      for (const x of v) console.log(`\n${n}: ${x.code}\n  ${x.why}\n  ${x.remedy}`);
  } else {
    console.log('\nnothing flagged.');
  }
}
