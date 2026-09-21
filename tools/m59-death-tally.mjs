// Durable recent-death counts from the keeper post-mortems.
//
// A keeper's in-memory `tally.deaths` is useful for diagnosing one process lifetime,
// but it is not a fleet-board count: a rolling keeper restart resets it to zero.  The
// post-mortem is written at the death boundary, before escape/rejoin can erase the
// evidence, and one file represents one observed death.  This module keeps the small
// filesystem/read/shape rule outside the broker so it can be tested without starting a
// live fleet.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEATH_WINDOW_MS = 24 * 60 * 60 * 1000;

// HOW FAR BEFORE THE WINDOW A FILE'S MTIME MAY SIT AND STILL BE WORTH OPENING.
//
// The pre-filter below decides whether to read a post-mortem from its mtime rather than from
// its contents, so the slack is the whole safety argument. A post-mortem is written AT the
// death boundary, so its mtime is at or after the `at` inside it; a file rewritten later only
// moves mtime forward, which reads the file and then rejects it on the real filter. The only
// way to lose a death is an mtime EARLIER than the death it records, which needs the clock to
// have gone backwards. An hour covers that and costs one stat.
export const MTIME_SLACK_MS = 60 * 60 * 1000;

/**
 * The death time a post-mortem's FILE NAME claims, or NaN when the name does not carry one.
 *
 * `Zoot-2026-09-20T19-06-51-226Z.json` — the writer names the file after the death it records,
 * so the cheapest possible pre-filter needs no syscall at all. Checked against the real prod
 * directory on 2026-09-20: 400 of 400 names parsed and every one matched the `at` inside the
 * file to the MILLISECOND, with no file failing to parse.
 *
 * A name is a claim, so anything that does not parse falls back to the stat and then to the
 * read. That is what keeps an older naming scheme, or a file somebody renamed, from silently
 * disappearing out of the count.
 */
export function deathTimeFromName(file) {
  const m = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/i.exec(String(file));
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
}

/**
 * A POST-MORTEM IS 1.8 MB AND THE TALLY NEEDS ABOUT TWELVE FIELDS OF IT.
 *
 * Skipping the out-of-window files took the prod read from 592 MB to 102 MB, and the 102 MB
 * that is left is 58 IN-window records at 1.8 MB each — they carry the replay, and the fleet
 * board wants a count. Reading and parsing them is 446 ms of blocked event loop, every time
 * the five-second cache above it expires.
 *
 * So each file is parsed ONCE, ever, and what is kept is this projection. A post-mortem is
 * written at the death boundary and never rewritten, so the path is a sufficient key: the
 * file that was there a minute ago has the same contents now or does not exist. Entries for
 * files that have left the window are dropped on the next scan, so the map is bounded by the
 * window rather than by uptime.
 *
 * The shape deliberately MATCHES the record's own nesting rather than flattening it, so
 * `countRecentDeaths` is unchanged and still works on raw records — a projection that needed
 * its consumer rewritten would be a second format to keep in step.
 */
export function projectPostmortem(record) {
  return {
    at: record?.at,
    character: record?.character,
    reason: record?.reason,
    where: record?.where ? {
      room: record.where.room ?? null, num: record.where.num ?? null,
      col: record.where.col ?? null, row: record.where.row ?? null,
    } : null,
    vitals: record?.vitals ? {
      level: record.vitals.level ?? null,
      last_health: record.vitals.last_health ?? null,
      last_vigor: record.vitals.last_vigor ?? null,
    } : null,
    was: record?.was ? {
      hunting: record.was.hunting ?? null,
      strategy: record.was.strategy ?? null,
      in_safe_spot: record.was.in_safe_spot ?? false,
    } : null,
  };
}

// Path -> projection. See projectPostmortem for why a path is a sufficient key.
const parsed = new Map();

export function countRecentDeaths(records = [], {
  now = Date.now(), sinceMs = DEATH_WINDOW_MS,
} = {}) {
  const cutoff = now - sinceMs;
  const by = new Map();
  for (const record of records) {
    const at = Number(record?.at);
    const character = String(record?.character || '').trim();
    if (!character || !Number.isFinite(at) || at < cutoff || at > now + 60_000) continue;
    const row = by.get(character) ?? {
      count: 0, in_safe_spot: 0, in_proven_safe_spot: 0, last: null,
    };
    row.count++;
    if (record?.was?.in_safe_spot) {
      row.in_safe_spot++;
      if (record.was.in_safe_spot?.proven === true) row.in_proven_safe_spot++;
    }
    if (!row.last || at > row.last.at) {
      row.last = {
        at,
        reason: record.reason ?? 'died',
        died_in: record.where?.room ?? null,
        room_num: record.where?.num ?? null,
        col: record.where?.col ?? null,
        row: record.where?.row ?? null,
        level: record.vitals?.level ?? null,
        last_health: record.vitals?.last_health ?? null,
        last_vigor: record.vitals?.last_vigor ?? null,
        hunting: record.was?.hunting ?? null,
        strategy: record.was?.strategy ?? null,
        in_safe_spot: record.was?.in_safe_spot ?? false,
      };
    }
    by.set(character, row);
  }
  return by;
}

/**
 * ASK THE DIRECTORY ENTRY BEFORE OPENING THE FILE.
 *
 * This read every post-mortem in the directory and then threw away everything outside the
 * window. That is fine for a week and ruinous for a year: `substrate/postmortems/` on prod is
 * **3,746 files and 616 MB**, it is read on the broker's event loop, and the caller is the
 * `fleet` tool — the most-called tool on the broker, behind a five-second cache that a
 * dashboard, a TUI, a supervisor and a bot between them refill continuously.
 *
 * Measured on prod 2026-09-20, by the broker's own stall profiler, on the first night it had
 * one:
 *
 *     [loop] broker event loop was blocked ~18882ms ...
 *       hot: readRecentDeaths m59-death-tally.mjs:53 4007ms, readFileUtf8 :0 3232ms,
 *            readFileSync node:fs:428 1832ms
 *       | callers: run m59-broker.mjs:16241 9656ms, recentDeathsIn 8952ms
 *
 * — one of eleven such stalls in three minutes, and the source of a sustained 86-127 MB/s of
 * reads with zero writes that four separate sessions failed to attribute by inspection. While
 * the loop is blocked the broker cannot answer a keeper's readiness probe, so the rejoin
 * declares live keepers dead and the fleet collapses to three or four characters.
 *
 * Yesterday's window held 57 deaths. It was reading 3,746 files to find them.
 *
 * A stat is not free either, but it is three orders of magnitude cheaper than opening and
 * parsing 164 KB, and it never touches the file's contents.
 */
export function readRecentDeaths(dir, options = {}) {
  if (!dir || !existsSync(dir)) return new Map();
  const { now = Date.now(), sinceMs = DEATH_WINDOW_MS } = options;
  const floor = now - sinceMs - MTIME_SLACK_MS;
  const records = [];
  const seen = new Set();
  for (const file of readdirSync(dir)) {
    if (!/\.json$/i.test(file)) continue;
    // THE NAME FIRST, BECAUSE IT COSTS NOTHING. Three thousand stats is a tenth of a second
    // of blocked loop every five seconds; three thousand regex matches is not measurable.
    const named = deathTimeFromName(file);
    if (Number.isFinite(named)) { if (named < floor) continue; }
    else {
      // A name that does not parse is a question, not an answer: fall back to the stat, and
      // to reading the file if even that fails. Never skip on an unknown.
      try { if (statSync(join(dir, file)).mtimeMs < floor) continue; } catch { /* read it */ }
    }
    const path = join(dir, file);
    seen.add(path);
    const cached = parsed.get(path);
    if (cached) { records.push(cached); continue; }
    try {
      const small = projectPostmortem(JSON.parse(readFileSync(path, 'utf8')));
      parsed.set(path, small);
      records.push(small);
    } catch { /* a partial/corrupt post-mortem is not a death we can prove */ }
  }
  // BOUNDED BY THE WINDOW, NOT BY UPTIME. Anything that did not come up in this scan has left
  // the window or the directory; keeping it would make a broker that has been up for a week
  // hold a week of projections for deaths nothing will ever ask about again.
  if (parsed.size > seen.size) for (const path of parsed.keys()) if (!seen.has(path)) parsed.delete(path);
  return countRecentDeaths(records, options);
}

const cache = new Map();
export function recentDeathsIn(dir, {
  now = Date.now(), sinceMs = DEATH_WINDOW_MS, maxAgeMs = 5000,
} = {}) {
  const key = `${dir}\0${sinceMs}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < maxAgeMs) return hit.by;
  const by = readRecentDeaths(dir, { now, sinceMs });
  cache.set(key, { at: now, by });
  return by;
}
