#!/usr/bin/env node
// WHAT HAPPENED BETWEEN TWO SERVER SAVES — the half no checkpoint contains.
//
//   node tools/m59-savelog.mjs                  the last few windows, printed
//   node tools/m59-savelog.mjs --write          append closed ones to substrate/savelog/<fleet>.jsonl
//   node tools/m59-savelog.mjs --all            every window on disk, oldest first
//   node tools/m59-savelog.mjs --since 24h
//
// ============================================================ STOCK AND FLOW
//
// The server's own save holds the STOCK: every inventory, vault, chest and position, and we
// keep two copies of it (a standing save and a fresh checkpoint). Recording any of that again
// would be a third copy of a file that is already authoritative, and a worse one.
//
// What a save cannot hold is the FLOW — what was killed, how far anybody walked, what was
// earned, who died and to what — between one save and the next. That is gone the instant it
// happens, and it is the only thing here that cannot be recovered by loading a checkpoint.
// So this records flow and nothing else. Positions, packs and vaults are deliberately absent;
// if you want them, load the checkpoint for the same instant, which is the point of aligning
// to this boundary at all.
//
// ============================================================ WHERE THE BOUNDARY COMES FROM
//
// Not a timer. `user.kod GarbageCollecting()` sends every logged-in player BP_WAIT when the
// save starts and BP_UNWAIT when it ends (:2154, :2182), and m59-client.mjs emits those as a
// `server-save` event which m59-game.mjs writes to the ledger as `server_save`. So the window
// edges are the SERVER's own, observed rather than assumed — which matters because
// `[Auto] SavePeriod` lives in a config this process cannot read and the operator can change
// without telling anyone.
//
// ALL TWENTY-THREE KEEPERS SEE EACH SAVE, so the markers arrive in a burst. They are collapsed
// on a tolerance below, because twenty-three rows one second apart are one event.
//
// ============================================================ TALLIES COME FROM EVENTS
//
// Never from a keeper's own counters. Those reset when a keeper restarts, which is roughly
// once a minute under load and every time anybody deploys — a tally read across a restart
// silently under-reports and looks perfectly healthy doing it. Everything below is computed by
// replaying the ledger between two timestamps, which is restart-proof by construction.
//
// ============================================================ IMPORTABLE ON PURPOSE
//
// Everything above `main()` is pure and exported, and the entry-point guard at the bottom is
// what keeps `import` from driving the tool — the same arrangement m59-supervise.mjs uses. It
// is not tidiness: a reader that can only be exercised by running it against a live fleet is
// a reader nobody checks, and the whole point of this file is that its numbers get believed
// six weeks later. `m59-savelog-test.mjs` builds a synthetic ledger and asserts on the window.
import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';

// ---------------------------------------------------------------- reading the ledger
export function readLedger(dir, floor = 0) {
  const rows = [];
  if (!dir || !existsSync(dir)) return rows;
  for (const f of readdirSync(dir).filter(x => /^fleet-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
    for (const ln of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (!o?.t || o.t < floor) continue;
      rows.push(o);
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

// ---------------------------------------------------------------- the save markers
// TWENTY-THREE CLIENTS, ONE EVENT. Collapse anything inside the tolerance into one boundary.
// 20s rather than 2s because a save holds the world and the UNWAIT reaches a loaded keeper
// late; the cost of collapsing too wide is a missed boundary, which shows up as one long
// window rather than as a wrong number — and one long window is readable, while a boundary in
// the wrong place silently moves events from one build's account into another's.
export const COLLAPSE_MS = 20_000;

export function boundaries(rows, collapseMs = COLLAPSE_MS) {
  const marks = [];
  for (const r of rows) {
    if (r.kind !== 'server_save' || r.phase !== 'begin') continue;
    const last = marks[marks.length - 1];
    if (last && r.t - last.at < collapseMs) { last.saw++; continue; }
    marks.push({ at: r.t, saw: 1 });
  }
  return marks;
}

// ---------------------------------------------------------------- one window
//
// EVERY FIELD NAME BELOW WAS READ OFF THE LEDGER ON DISK, NOT GUESSED.
//
// The first draft of this file counted `k.what ?? k.target ?? k.name` for a kill. The real
// field is `creature`, so every kill in every window would have been filed as "unnamed" —
// a total that adds up correctly, a breakdown that is entirely empty, and nothing anywhere
// saying so. Same for two death splits (`players_present` and `doing`) that do not exist on
// a `died` row at all, and would have reported zero PVP deaths and zero travel deaths for
// ever.
//
// That is this repository's standing failure mode — a reader that cannot fail — so
// `unaccounted` below names every kind in the window that nothing here counts. When somebody
// renames an event, the next run says so instead of reporting a quieter fleet.
const N = (x) => Number(x) || 0;
const pct = (n, d) => (d ? Number((n / d * 100).toFixed(1)) : null);
const rate = (n, d, per = 1) => (d ? Number((n / d * per).toFixed(2)) : null);
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))]);
};

// Every kind this file reads. Anything in the ledger and not in here is reported once per
// window, so a rename surfaces as a line of output rather than as a smaller number.
export const COUNTED = new Set([
  'killed', 'died', 'level_up', 'level_lost', 'travel_journey', 'zone_change',
  'travel_hold', 'travel_paused_for_wall', 'travel_resumed', 'travel_resume_dropped',
  'travel_pause', 'shuffle', 'stalled', 'unstalled', 'stuck_backed_up', 'wedge_gave_up',
  'blink_rest', 'bought', 'looted', 'left_pack', 'town_trip_completed', 'cast',
  'cast_declined', 'fought_back', 'grind_suppressed', 'first_seen',
  'left_the_newbie_zone', 'server_save',
]);

export function window(rows, from, to) {
  const span = rows.filter(r => r.t >= from && r.t < to);
  const by = (k) => span.filter(r => r.kind === k);

  const chars = new Set(span.map(r => r.character).filter(Boolean));
  const hours = (to - from) / 3600e3;

  // ---- what was fought. `creature` is the field; see the note above.
  const kills = by('killed');
  const quarry = {};
  for (const k of kills) { const q = k.creature ?? 'unnamed'; quarry[q] = N(quarry[q]) + 1; }
  const killRooms = {};
  for (const k of kills) { const r = k.room_num ?? k.room ?? '?'; killRooms[r] = N(killRooms[r]) + 1; }

  // ---- what died, split every way the record can actually support.
  //
  // PVP IS THE ONE EXEMPTION AND IT HAS TO BE SHOWN. `was_killed_by_player` is carried beside
  // `killed_by_player_is_a_guess` rather than folded into it, because the guess is about half
  // right and this fleet has already once turned six trolls into a PVP death by reading one
  // without the other. Both are recorded; nothing here decides.
  const deaths = by('died');
  const pvpShown = deaths.filter(d => d.was_killed_by_player === true && d.killed_by_player_is_a_guess === false);
  const pvpGuess = deaths.filter(d => d.was_killed_by_player === true && d.killed_by_player_is_a_guess !== false);
  // `was_travelling` is null on any death written before that field existed, so the three
  // states are counted apart rather than folded into a boolean — which would read every old
  // row as "not travelling" and halve the number this whole effort is about.
  const travelDeaths = deaths.filter(d => d.was_travelling === true);
  const unclassified = deaths.filter(d => d.was_travelling == null);
  const killerOf = (d) => String(d.killed_by ?? '').split(',')[0].trim() || 'unnamed';
  const killers = {};
  for (const d of deaths) { const k = killerOf(d); killers[k] = N(killers[k]) + 1; }

  // ---- journeys, with the quality measures the #movement work is judged on.
  //
  // A count of journeys says whether the fleet moved. These say whether it moved WELL, and
  // they are the columns an A/B of two cherry-picked #movement commits is actually read on.
  const journeys = by('travel_journey');
  const arrived = journeys.filter(j => j.arrived === true);
  const jms = arrived.map(j => N(j.ms)).filter(Boolean);
  const stumbles = journeys.reduce((a, j) => a + N(j.stumbles), 0);
  const overPlan = journeys.filter(j => N(j.legs) > N(j.planned_legs)).length;
  const hpLost = journeys.reduce((a, j) => a + Math.max(0, N(j.hp_start) - N(j.hp_end)), 0);

  // ---- the only thing this fleet is for.
  const ups = by('level_up'), downs = by('level_lost');
  const net = ups.reduce((a, e) => a + Math.max(0, N(e.to) - N(e.from)), 0)
            - downs.reduce((a, e) => a + Math.max(0, N(e.from) - N(e.to)), 0);

  // ---- money, as FLOW. What was spent and earned, never what is held: holdings are in the
  // checkpoint for this same instant, which is the entire point of aligning to this boundary.
  const bought = by('bought');
  const trips = by('town_trip_completed');

  return {
    from, to, minutes: Math.round((to - from) / 60000),
    characters: chars.size,

    // ======== FIGHTING
    kills: kills.length,
    kills_per_character_hour: rate(kills.length, chars.size * hours),
    kills_by_quarry: quarry,
    kills_by_room: killRooms,
    fought_back: by('fought_back').length,

    // ======== DYING
    deaths: deaths.length,
    deaths_pvp_shown: pvpShown.length,
    deaths_pvp_guessed: pvpGuess.length,
    deaths_travelling: travelDeaths.length,
    deaths_unclassified: unclassified.length,
    deaths_unattended: deaths.filter(d => d.unattended === true).length,
    deaths_at_a_safe_wall: deaths.filter(d => d.at_a_safe_wall && d.at_a_safe_wall !== false).length,
    deaths_in_safe_spot: deaths.filter(d => d.in_safe_spot && d.in_safe_spot !== false).length,
    deaths_by_killer: killers,
    // NEVER A COUNT WITHOUT ITS OPPORTUNITY. Travel deaths per DAY fell 84 -> 5 while the
    // journeys quadrupled, and only the rate showed the real size of that (20.7 -> 0.3 per
    // thousand). A window is minutes long, so a per-day figure is noise; the rate is the only
    // number two windows can honestly be compared on.
    // AND `null` RATHER THAN 0 WHEN NOTHING WAS CLASSIFIED. Every death written before
    // `was_travelling` existed is unclassified, so a window of those has a numerator of zero
    // for the wrong reason — and 0.0 travel deaths per thousand journeys is precisely the
    // false green this whole file is built to refuse. Unknown has to look unknown.
    deaths_per_1000_journeys: (deaths.length && unclassified.length === deaths.length)
      ? null : rate(travelDeaths.length, journeys.length, 1000),
    levels_gained: ups.length,
    levels_lost: downs.length,
    net_levels: net,

    // ======== MOVING
    journeys: journeys.length,
    journeys_arrived: arrived.length,
    arrival_rate_pct: pct(arrived.length, journeys.length),
    journey_ms_p50: quantile(jms, 0.5),
    journey_ms_p90: quantile(jms, 0.9),
    journey_held_ms: journeys.reduce((a, j) => a + N(j.held_ms), 0),
    journey_stumbles: stumbles,
    journeys_over_plan: overPlan,
    journey_hp_lost: hpLost,
    zone_changes: by('zone_change').length,
    travel_holds: by('travel_hold').length,
    travel_paused_for_wall: by('travel_paused_for_wall').length,
    travel_resumed: by('travel_resumed').length,
    travel_resume_dropped: by('travel_resume_dropped').length,
    shuffles: by('shuffle').length,
    stalled: by('stalled').length,
    unstalled: by('unstalled').length,
    wedge_gave_up: by('wedge_gave_up').length,
    stuck_backed_up: by('stuck_backed_up').length,

    // ======== EARNING AND SPENDING
    bought: bought.length,
    shillings_spent: bought.reduce((a, b) => a + N(b.cost), 0),
    town_trips: trips.length,
    town_trip_net_shillings: trips.reduce((a, t) => a + N(t.net_shillings), 0),
    vendor_sales: trips.reduce((a, t) => a + N(t.vendor_sales), 0),
    looted: by('looted').length,
    left_pack: by('left_pack').length,
    casts: by('cast').length,
    casts_declined: by('cast_declined').length,
    grind_suppressed: by('grind_suppressed').length,

    // ======== THE READER'S OWN HONESTY CHECK
    // Every kind present in this window that nothing above counts. Empty is the healthy
    // answer; a name appearing here is either a new event worth adding or one that was
    // renamed out from under this file, and either way it is a line of output rather than a
    // number that quietly got smaller.
    unaccounted: [...new Set(span.map(r => r.kind).filter(k => k && !COUNTED.has(k)))].sort(),
  };
}

// ---------------------------------------------------------------- provenance
//
// A WINDOW IS ONLY COMPARABLE TO ANOTHER IF YOU KNOW WHAT WAS RUNNING DURING IT. The private
// SHA is the one that describes the WHOLE fleet — code AND orders — which is why it is here
// rather than only the deploy tag: two windows on the same harness commit with different
// loadouts are not the same experiment, and nothing in this repository would have said so.
const git = (repo, ...a) => {
  try {
    return execFileSync('git', ['-C', repo, ...a],
                        { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};

export function provenanceOf(env = process.env, repo = null) {
  const PROD = env.M59_PROD_DEPLOY || 'C:/code/m59-lab/prod-deploy';
  const pointer = repo ? join(repo, 'substrate', 'private-repo') : null;
  const priv = env.M59_PRIVATE_REPO
    ?? (pointer && existsSync(pointer) ? readFileSync(pointer, 'utf8').trim() : null);
  return {
    harness: git(PROD, 'rev-parse', 'HEAD'),
    deploy_tag: git(PROD, 'describe', '--tags'),
    private_pin: priv ? git(priv, 'rev-parse', 'HEAD') : null,
    dum: git(env.M59_DUM_HEAD || 'C:/code/mindmap/maps/meridian59-dum-bot', 'rev-parse', 'HEAD'),
  };
}

// ---------------------------------------------------------------- the tool
function main() {
  const arg = (name, dflt = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
      ? process.argv[i + 1] : dflt;
  };
  const has = (n) => process.argv.includes(`--${n}`);

  const FLEET = fleetName();
  const LEDGER = ledgerDirFor(FLEET);
  // BESIDE THE LEDGER IT IS DERIVED FROM — derived FROM that path, not resolved again.
  //
  // `evidenceDirFor()` and `ledgerDirFor()` do not agree in a worktree: prod's ledger lands in
  // the pinned deploy's own substrate, while evidenceDirFor deliberately sends evidence home to
  // the checkout the worktree was cut from. Resolving this one independently would put a
  // summary in one tree describing a ledger in another, and the mismatch would present as
  // missing days rather than as a path bug. So it hangs off the ledger directory and cannot
  // drift from it: <...>/substrate/history/<fleet> -> <...>/substrate/savelog.
  const OUT = join(LEDGER, '..', FLEET ? '..' : '.', 'savelog');

  const ms = (s) => {
    const m = /^(\d+)([hdm])$/.exec(String(s ?? ''));
    return m ? Number(m[1]) * ({ m: 60e3, h: 3600e3, d: 86400e3 })[m[2]] : null;
  };
  const sinceArg = arg('since', has('all') ? null : '48h');
  const floor = sinceArg ? Date.now() - (ms(sinceArg) ?? 48 * 3600e3) : 0;

  const rows = readLedger(LEDGER, floor);
  const marks = boundaries(rows);

  if (!marks.length) {
    console.log(`no server_save markers in ${LEDGER} for "${FLEET || '(unnamed)'}".`);
    console.log('');
    console.log('  That is expected until a keeper restarts onto the build that emits them —');
    console.log('  m59-client.mjs raises `server-save` on BP_WAIT/BP_UNWAIT (user.kod:2154,2182)');
    console.log('  and m59-game.mjs writes it to the ledger. Until then there is no honest');
    console.log('  window boundary, and this refuses to invent one from a SavePeriod it cannot');
    console.log("  read — an assumed boundary would file one build's events under another.");
    return;
  }

  const windows = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].at;
    const to = marks[i + 1]?.at ?? Date.now();
    // The open window is reported but never written: a partial tally appended as though it
    // were a closed one is a number that quietly shrinks the average of everything it is ever
    // compared to, and nothing downstream can tell it from a bad afternoon.
    windows.push({ ...window(rows, from, to), open: i === marks.length - 1,
                   keepers_saw: marks[i].saw });
  }

  for (const w of has('all') ? windows : windows.slice(-3)) {
    const when = new Date(w.from).toLocaleString();
    console.log(`\n=== save at ${when}${w.open ? '   (OPEN — still running, not written)' : ''}`);
    console.log(`    ${w.minutes} min, ${w.characters} character(s), ${w.keepers_saw} keeper(s) saw the save`);
    console.log(`    kills ${w.kills} (${w.kills_per_character_hour ?? '-'}/char/h)   `
              + `levels +${w.levels_gained} -${w.levels_lost} (net ${w.net_levels})`);
    console.log(`    deaths ${w.deaths}: ${w.deaths_travelling} travelling, `
              + `${w.deaths_pvp_shown} PVP shown, ${w.deaths_pvp_guessed} PVP guessed, `
              + `${w.deaths_unattended} unattended, ${w.deaths_at_a_safe_wall} at a safe wall`
              + (w.deaths_unclassified ? `, ${w.deaths_unclassified} unclassified` : ''));
    console.log(`    journeys ${w.journeys}  arrived ${w.arrival_rate_pct ?? '-'}%  `
              + `p50 ${w.journey_ms_p50 ?? '-'}ms p90 ${w.journey_ms_p90 ?? '-'}ms  `
              + `stumbles ${w.journey_stumbles}  over plan ${w.journeys_over_plan}`);
    console.log(`    travel deaths per 1000 journeys: ${w.deaths_per_1000_journeys ?? '-'}`);
    console.log(`    stalls ${w.stalled}/${w.unstalled}  shuffles ${w.shuffles}  `
              + `wedges given up ${w.wedge_gave_up}  holds ${w.travel_holds}`);
    console.log(`    bought ${w.bought} (${w.shillings_spent} sh)  town trips ${w.town_trips} `
              + `(net ${w.town_trip_net_shillings} sh)  looted ${w.looted}  casts ${w.casts}`
              + (w.casts_declined ? ` (${w.casts_declined} declined)` : ''));
    const top = Object.entries(w.kills_by_quarry).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) console.log(`    quarry: ${top.map(([q, n]) => `${q} ${n}`).join(', ')}`);
    const bykill = Object.entries(w.deaths_by_killer).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (bykill.length) console.log(`    killers: ${bykill.map(([q, n]) => `${q} ${n}`).join(', ')}`);
    // LOUD ON PURPOSE. A kind nothing counts is the one way this file can be wrong while every
    // number in it still adds up, so it prints even in the terse per-window summary.
    if (w.unaccounted.length)
      console.log(`    NOT COUNTED BY THIS READER: ${w.unaccounted.join(', ')}`);
  }

  if (!has('write')) return;

  const provenance = provenanceOf(process.env, join(OUT, '..', '..'));
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${FLEET || 'default'}.jsonl`);
  const already = existsSync(path)
    ? new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l).from; } catch { return null; } }))
    : new Set();
  let wrote = 0;
  for (const w of windows) {
    if (w.open || already.has(w.from)) continue;     // closed windows only, and never twice
    appendFileSync(path, JSON.stringify({ schema: 'm59-savelog/1', fleet: FLEET || null,
                                          provenance, ...w }) + '\n');
    wrote++;
  }
  console.log(`\n  ${wrote} closed window(s) appended to ${path}`);
  console.log(`  pinned to ${provenance.deploy_tag ?? '?'} / harness `
            + `${String(provenance.harness ?? '-').slice(0, 8)} / private `
            + `${String(provenance.private_pin ?? '-').slice(0, 8)}`);
  // A WINDOW WITH NO PROVENANCE IS A NUMBER WITH NOTHING TO ATTRIBUTE IT TO. It is still
  // written — losing the evidence is worse than losing the label — but it says so, because
  // this is exactly what makes a whole week of records useless for an A/B six weeks later.
  if (!provenance.harness)
    console.log('  WARNING: no harness SHA. Set M59_PROD_DEPLOY, or these windows cannot be'
              + ' attributed to a build.');
}

// IMPORTING MUST NOT RUN THE TOOL. See the note at the top of the file.
if (process.argv[1] && /m59-savelog\.mjs$/.test(process.argv[1])) main();
