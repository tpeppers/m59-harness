// The long record: what happened to each character, over days.
//
// This is deliberately NOT the flight recorder. That one keeps two-minute windows and
// throws away everything older than half an hour, which is right for "why is this
// character standing still" and useless for "what has become of the fleet since
// yesterday". The two want opposite things — one wants everything for a short time,
// the other wants a little for a long time — so they are separate files with separate
// lifetimes and nothing is rotated out of this one.
//
// Keyed by CHARACTER NAME, never by agent name or object id. Agent names are a broker
// convention and get reassigned; object ids are renumbered by every `save game`. The
// character name is the only identifier that means the same thing tomorrow.
//
// Two kinds of line, both JSONL, appended and never rewritten:
//
//   sample   a periodic snapshot of every character — level, kills, deaths, where
//   event    something worth knowing the moment it happened: a level gained, a
//            death, leaving the newbie zone, a stall that lasted
//
// Samples alone would answer "how far did it get". Events alone would answer "what
// happened to it". Neither alone answers "why did it stop gaining at four in the
// morning", which is the question actually worth being able to ask.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';

// Per-fleet, because this is keyed by character name and names are only unique
// within a server. See ledgerDirFor. Naming no fleet keeps the original directory,
// so an existing checkout's history stays exactly where it was.
const DIR = ledgerDirFor(fleetName());

const dayFile = (t = Date.now()) =>
  join(DIR, 'fleet-' + new Date(t).toISOString().slice(0, 10) + '.jsonl');

// A TEST MUST NEVER WRITE INTO A REAL FLEET'S HISTORY.
//
// This file is appended and never rotated — it is the only record of what the fleet
// did over days, and the reports built on it are read as fact. A test fixture's
// character landing in it is not a cosmetic problem: `Tester` becomes a character in
// the audit, and nothing downstream can tell it from a real one.
//
// It happened the moment the keeper started recording its own casts. The offline
// suites build extremely convincing sessions — fake client, fake pacer, a character
// with a name — so nothing about the OBJECT distinguishes a test from a keeper by
// inspection. The entry point does, and a fixture cannot fake it.
//
// The rule is therefore: a test that touches keeper code sets M59_LEDGER_DIR to a
// scratch directory, exactly as m59-ledger-test.mjs does. If it forgets, this says so
// on stderr instead of quietly corrupting the record.
const IS_TEST = /[\\/]m59-[a-z-]+-test\.mjs$/.test(process.argv[1] || '');
let warnedTestWrite = false;

function append(obj) {
  if (IS_TEST && !process.env.M59_LEDGER_DIR) {
    if (!warnedTestWrite) {
      warnedTestWrite = true;
      console.error('[ledger] REFUSING to write from a test into ' + DIR +
                    '\n[ledger] set M59_LEDGER_DIR to a scratch directory before importing ' +
                    'anything that records — see m59-ledger-test.mjs');
    }
    return;
  }
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(dayFile(), JSON.stringify(obj) + '\n');
  } catch (e) {
    // Never let bookkeeping break play.
    console.error('[ledger] ' + e.message);
  }
}

// Last seen state per character, so events can be derived from samples rather than
// having to be reported from a dozen call sites that would each forget one.
const last = new Map();

// THE PAYLOAD MUST NOT BE ABLE TO OVERWRITE THE EVENT'S OWN FIELDS.
//
// `detail` is spread over the record, so a detail field called `kind` silently becomes
// the event kind — an item purchase carrying `kind: 'elderberry'` files itself as an
// elderberry event, every reader filtering on 'bought' finds nothing, and the write
// itself looks perfectly fine. This is the same shape as the `emit(kind, data)` bug in
// m59-client, and it cost the same afternoon twice.
//
// So the identity fields are applied AFTER the spread. A caller that puts `kind` in a
// detail is always making a mistake; this makes the mistake inert rather than silent.
export function recordEvent(character, kind, detail = {}) {
  if (!character) return;
  append({ t: Date.now(), iso: new Date().toISOString(), ...detail,
           type: 'event', character, kind });
  // AND LET A PRIVATE STRATEGY KNOW, AFTER THE ROW IS SAFELY WRITTEN.
  //
  // This is the fleet's one choke point for "something notable happened", which is exactly
  // what a hook wants to subscribe to -- so hooks hang here rather than every emitter growing
  // its own listener list. See tools/m59-hooks.mjs for the rules a handler runs under.
  //
  // ORDER MATTERS AND IS NOT NEGOTIABLE: the append is above, the fire is below. Losing the
  // record of what happened is worse than losing the reaction to it, and a hook that throws
  // must never be able to cost us the evidence. `fireEvent` itself cannot throw.
  //
  // LAZY, AND SILENT WHEN ABSENT. The ledger is imported by tools that must never start a
  // keeper, so it cannot import the hook loader at module scope. No hooks registered is the
  // shipped behaviour, and it costs one Map lookup.
  if (_fireEvent) {
    try { _fireEvent(kind, { character, kind, detail }); } catch { /* never the ledger's problem */ }
  }
}

// Wired by whoever loads hooks (the broker/keeper at startup), so a tool that only reads the
// ledger never pulls the hook machinery in. Absent = no hooks, which is the default.
let _fireEvent = null;
export function attachHooks(fire) { _fireEvent = typeof fire === 'function' ? fire : null; }

// `rows` is the fleet tool's own output, so the ledger records exactly what a
// supervisor would have seen rather than a second, subtly different view.
export function recordSample(rows = []) {
  const t = Date.now();
  for (const r of rows) {
    const name = r.character;
    if (!name) continue;
    const now = {
      level: r.level ?? null,
      kills: r.autopilot?.kills ?? 0,
      deaths: r.deaths ?? null,
      // Restart-safe rolling count from keeper post-mortems.  `deaths` above remains the
      // current keeper process tally for compatibility; this is the fleet-board figure.
      deaths_24h: r.deaths_24h ?? null,
      room: r.room ?? null,
      room_num: r.room_num ?? null,
      health: r.health ?? null,
      mana: r.mana ?? null,
      vigor_of: r.vigor_of ?? null,
      has_weapon: r.has_weapon ?? null,
      has_food: r.has_food ?? null,
      activity: r.activity ?? null,
      // The current learning threshold is a latest reading, just like health. Keep the
      // compact target and the next planned purchase so /fleet still answers after the
      // broker goes dark; the full candidate list remains in the live fleet row.
      learning_progress: r.learning?.progress ?? null,
      planned_learning: r.learning?.planned ? {
        configured: r.learning.planned.configured ?? 0,
        ready: r.learning.planned.ready ?? 0,
        next: r.learning.planned.next ?? null,
      } : null,
      // WHAT IT IS CARRYING, IN THE THREE QUANTITIES THAT DECIDE WHETHER IT CAN KEEP
      // WORKING. The purse buys the reagents, the reagents become food, and food is the
      // only way past the vigor-80 resting cap — so an economy that has stopped moving
      // is a fleet that will quietly stop earning some hours later.
      //
      // These have NO OTHER HOME. A bank balance survives in substrate/banks/ because a
      // banker says it out loud and it is written down; a purse and a pack are only ever
      // what the inventory says right now, and nothing was keeping them. So the sample is
      // their record, and the Economy board is built on it.
      //
      // The bank balance is deliberately NOT copied here. It already has a record with
      // its own timestamps and its own observed/derived flag, and a quantity with two
      // homes in this repository has always ended up with two answers.
      purse: r.purse ?? null,
      elderberry: r.reagents?.elderberry ?? null,
      herbs: r.reagents?.herbs ?? null,
      deaths_in_safe_spot: r.deaths_in_safe_spot ?? null,
      deaths_in_proven_safe_spot: r.deaths_in_proven_safe_spot ?? null,
      mulligans: r.mulligans ?? null,
      logoffs: r.logoffs ?? null,
      stalled: r.stalled && r.stalled !== false ? (r.stalled.why || String(r.stalled)) : null,
      strategy: r.strategy ?? null,
      stalled_pct: r.time?.stalled_pct ?? null,
      active_s: r.time?.active_s ?? null,
      stalled_s: r.time?.stalled_s ?? null,
      fighting_s: r.time?.fighting_s ?? null,
      pulling_s: r.time?.pulling_s ?? null,
      waiting_s: r.time?.waiting_s ?? null,
      recovering_s: r.time?.recovering_s ?? null,
      zoning_s: r.time?.zoning_s ?? null,
      travelling_s: r.time?.travelling_s ?? null,
      death_sig: r.last_death?.at ?? null,
    };
    const was = last.get(name);

    // Derive the events. A level gain is the thing being farmed, so it is worth a
    // line of its own; so is losing one, which is what a death costs and the only
    // way to see the cost rather than just the fact.
    if (was) {
      if (now.strategy !== was.strategy)
        recordEvent(name, 'strategy_changed', { from: was.strategy, to: now.strategy, level: now.level });
      if (now.level != null && was.level != null && now.level !== was.level)
        recordEvent(name, now.level > was.level ? 'level_up' : 'level_lost',
                    { from: was.level, to: now.level, room: now.room });
      // The keeper reconstructs the death at the resolution it happened at — where,
      // at what health, against what — and stamps it. Record THAT rather than
      // inferring from a five-minute sample, which reported the inn a character had
      // been resting in rather than the field it died in.
      if (now.death_sig && now.death_sig !== was.death_sig) {
        // WRITE WHAT IS KNOWN, NOT A ROW OF `undefined`.
        //
        // The death signature changes the moment the keeper notices, and last_death is
        // filled in a beat later — it waits for the death broadcast on purpose. Sampling
        // in that gap wrote every field as undefined: no room, no vigor, no killer, not
        // even a note saying so. Two of nine deaths in one window looked like that, and
        // an undefined room is indistinguishable in the record from a death nobody
        // watched.
        //
        // The sample always knows where the character is and what level it is, so say
        // that much and mark the rest as not-yet-known rather than as nothing.
        const d = r.last_death || {};
        const thin = !d.died_in && d.last_health == null;
        // CARRY `how` ALONGSIDE `killed_by`, because a null killer is not one fact.
        //
        // Three of the broadcast forms name nobody — "murdered in cold blood" (a player
        // did it, and is deliberately not named), "slain by his own folly", and "met an
        // untimely end" (the room: lava, a fall, a trap) — and so does the case where no
        // broadcast arrived at all. All four arrived here as killed_by: null and became
        // indistinguishable the moment they were written down.
        //
        // It cost a real answer. Clifford died inside The Bhrama & Falcon, a town shop,
        // with a health trail of 29/29 four samples running and then dead — which is not
        // a monster wearing it down, and on a shared server the obvious question is
        // whether another player killed it. The record could not say.
        recordEvent(name, 'died', {
          died_in: d.died_in ?? now.room, level: d.level ?? now.level,
          health_trail: d.health_trail, last_health: d.last_health, last_vigor: d.last_vigor,
          killed_by: d.killed_by ? d.killed_by.join(', ') : null,
          how_died: d.how_died ?? null,
          death_broadcast: d.death_broadcast ?? null,
          // What was standing nearby, kept beside the authoritative answer rather than
          // instead of it — it is still the right answer to "how outnumbered were we".
          was_nearby: d.was_nearby ? d.was_nearby.join(', ') : null,
          killer_is_a_guess: d.killed_by_is_a_guess ?? false,
          unattended: d.unattended ?? false,
          hunting: d.hunting, strategy: d.strategy, flee_threshold: d.flee_threshold,
          // WAS IT AT A WALL, AND WAS THAT WALL PROVEN? The keeper reconstructs this into
          // `lastDeath.in_safe_spot` and the ledger was dropping it on the floor, so the one
          // question the whole safe-spot thesis turns on could not be asked of the record.
          //
          // The thesis predicts near-never: a working spot cannot be hit out of unless you
          // swing first, so a death in one means the square does not work, or the character
          // was caught walking in or out. Those are different problems with different fixes
          // and only this tells them apart. Asked of prod after seven deaths, the answer had
          // to be pieced together from tally counters instead -- five in the open, two on
          // UNPROVEN squares, none on a proven one -- which is the thesis holding up, and it
          // should not have taken that much work to find out.
          in_safe_spot: d.in_safe_spot
            ? { at: d.in_safe_spot.at ?? null, proven: !!d.in_safe_spot.proven,
                held_s: d.in_safe_spot.held_s ?? null }
            : (d.in_safe_spot === false ? false : null),
          // `false` means it was asked and the answer was no; `null` means nobody asked,
          // which is the distinction that made the old records unreadable.
          fled_in_time: d.fled_in_time ?? null,
          ...(thin ? { detail_missing: true,
                       note: 'the keeper had not finished reconstructing this death when the ' +
                             'sample caught it — room and level come from the sampler, the ' +
                             'rest was not known yet' } : {}),
        });
      } else if (now.room !== was.room && /Underworld/i.test(now.room || '') &&
                 !/Underworld/i.test(was.room || '')) {
        recordEvent(name, 'died', { was_in: was.room, level: now.level, note: 'inferred from sampling' });
      }
      if (was.room && /Raza|Mausoleum|Museum/i.test(was.room) && now.room &&
          !/Raza|Mausoleum|Museum/i.test(now.room))
        recordEvent(name, 'left_the_newbie_zone', { to: now.room, level: now.level });
      if (now.stalled && !was.stalled)
        recordEvent(name, 'stalled', { why: now.stalled, room: now.room, level: now.level });
      // WHAT CAME NEXT. A stall is only half the story; the useful half is what
      // resolved it, because that is what the keeper should have done sooner.
      if (!now.stalled && was.stalled)
        recordEvent(name, 'unstalled', { after: was.stalled, room: now.room,
                                         moved: now.room !== was.room });
    } else {
      recordEvent(name, 'first_seen', { level: now.level, room: now.room });
    }
    last.set(name, now);
    append({ t, type: 'sample', character: name, ...now });
  }
}

// Read it back. `since` is a millisecond timestamp; the default of 24 hours is the
// question this file exists to answer.
export function readLedger({ sinceMs = 24 * 3600 * 1000 } = {}) {
  if (!existsSync(DIR)) return { samples: [], events: [] };
  const cutoff = Date.now() - sinceMs;
  const samples = [], events = [];
  // Two days of files covers any 24-hour window regardless of when it started.
  const files = readdirSync(DIR).filter(f => /^fleet-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-3);
  for (const f of files) {
    for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.t < cutoff) continue;
      (o.type === 'event' ? events : samples).push(o);
    }
  }
  return { samples, events };
}

// KILLS IN A WINDOW, COUNTED FROM THE RECORD RATHER THAN FROM A COUNTER.
//
// The board's kills/30m column was structurally incapable of being anything but zero,
// in two separate ways, and both are worth writing down because either alone would have
// been enough to hide a working fleet.
//
// The first: the page renders `r.kills_30m` from rows built by summarise() below, and
// recordSample() never wrote that field. So it was permanently undefined, `?? 0` made it
// a number, and the template colours zero in the shade reserved for "this row is not
// working" — every character, every render, for ever.
//
// The second, which is why plumbing the field through would NOT have fixed it: the value
// being plumbed is Autopilot.killsSince(), which filters `this.killTimes`, an array on
// the keeper. The supervisor restarts keepers about once a minute, and the constructor
// starts that array empty. So the honest reading of the keeper's kills_30m is "kills
// since the last restart, capped at 30 minutes" — near-zero on this fleet no matter how
// well it is doing. Measured while investigating: at least 26 kills in half an hour with
// every column reading 0.
//
// Hence `killed` events, appended by the keeper at the moment of the kill, and this as
// the ONLY definition of the number. Both the web board (via summarise) and the broker's
// live rows count the same events, so the page and the terminal cannot disagree — which
// is the failure this repository keeps rediscovering whenever a quantity has two homes.
//
// It is still a floor rather than a total for anything killed before this code shipped:
// there are no `killed` events in the older history, and nothing can invent them.
export const KILL_WINDOW_MS = 30 * 60 * 1000;

export function countKills(events = [], from = 0) {
  const by = new Map();
  for (const e of events)
    if (e.kind === 'killed' && e.character && e.t >= from)
      by.set(e.character, (by.get(e.character) || 0) + 1);
  return by;
}

// For callers that are not already holding the ledger — the broker's fleet row builder,
// which runs on every tool call. readLedger parses whole day files, so the answer is
// memoised for a few seconds: this is a thirty-minute window, and a five-second-old
// count of it is not a lie worth re-reading a megabyte to avoid. `maxAgeMs` is how stale
// an answer the caller will accept; a test passes 0 and gets the file.
let killCache = { at: 0, ms: 0, by: new Map() };
export function killsIn(ms = KILL_WINDOW_MS, maxAgeMs = 5000) {
  const now = Date.now();
  if (killCache.ms === ms && now - killCache.at < maxAgeMs) return killCache.by;
  const { events } = readLedger({ sinceMs: ms });
  killCache = { at: now, ms, by: countKills(events, now - ms) };
  return killCache.by;
}

// THE DEATH POST-MORTEM. Not a dump of records — the point is the pattern.
//
// A death costs a point of maximum health outright, which is the exact thing being
// farmed, so a death is worth roughly an hour of the work that caused it. That makes
// "what do these have in common" the highest-value question the ledger can answer.
export function deathReport({ sinceMs = 24 * 3600 * 1000, limit = 20 } = {}) {
  const { events } = readLedger({ sinceMs });
  const deaths = events.filter(e => e.kind === 'died').slice(-limit);
  const tally = (key) => {
    const t = {};
    for (const d of deaths) {
      const v = d[key];
      if (v == null) continue;
      for (const one of String(v).split(', ')) t[one] = (t[one] || 0) + 1;
    }
    return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ what: k, deaths: n }));
  };
  return {
    deaths: deaths.length,
    window_hours: +(sinceMs / 3600000).toFixed(1),
    // The three cuts worth having. Repeat victims usually mean one character is
    // somewhere wrong; repeat rooms mean the ROOM is wrong for everyone sent there;
    // repeat killers mean the prey choice or the threat ceiling is wrong.
    by_character: tally('character'),
    by_room: tally('died_in'),
    by_killer: tally('killed_by'),
    by_strategy: tally('strategy'),
    recent: deaths.reverse().map(d => ({
      at: d.iso || new Date(d.t).toISOString(),
      character: d.character, level: d.level, died_in: d.died_in ?? d.was_in,
      health_trail: d.health_trail, last_health: d.last_health, last_vigor: d.last_vigor,
      killed_by: d.killed_by, hunting: d.hunting, strategy: d.strategy,
      flee_threshold: d.flee_threshold,
      ...(d.note ? { note: d.note } : {}),
    })),
    read_this_way:
      'health_trail is the last four samples before the death, oldest first. A trail ' +
      'that ends well above the flee threshold means the character was killed FASTER ' +
      'than one keeper pass — raising the threshold will not help and only fighting ' +
      'something weaker will. A trail that decays through the threshold means the ' +
      'withdrawal was attempted and lost, which is a speed problem, not a policy one.',
  };
}

// WHAT THE KEEPERS CAST, WHAT THEY REFUSED TO CAST, AND WHAT THEY BOUGHT INSTEAD.
//
// The fleet's supply plan is to make its own food rather than shop for it: `create
// food` turns 2 ElderBerry and 2 Herbs into a meal, and the two reagents drop free in
// the rooms these characters already hunt. Whether that plan is actually running is
// not visible anywhere else. Both spells it depends on refuse SILENTLY — create food
// without its reagents, create weapon below 15 mana — so a keeper whose supply loop
// has been broken since Tuesday looks exactly like one that simply had a quiet day.
//
// Four questions, and each needs a different one of these fields:
//
//   is it casting at all           by_spell[].cast
//   does casting WORK              by_spell[].worked — the one that matters
//   why is it not casting          declined, which no log of actions can tell you
//   is it shopping instead         purchases.by_kind — reagent, food, or neither
//
// `worked` is the number to read first. A count of casts alone cannot separate forty
// meals from forty silent refusals, and the fleet spent a while believing the first.
export function spellReport({ sinceMs = 24 * 3600 * 1000, character = null } = {}) {
  const { events } = readLedger({ sinceMs });
  const mine = (e) => !character || e.character?.toLowerCase() === character.toLowerCase();
  const casts = events.filter(e => e.kind === 'cast' && mine(e));
  const declines = events.filter(e => e.kind === 'cast_declined' && mine(e));
  const buys = events.filter(e => e.kind === 'bought' && mine(e));
  const buyDeclines = events.filter(e => e.kind === 'buy_declined' && mine(e));

  const bySpell = new Map();
  for (const e of casts) {
    const k = e.spell || 'unknown';
    const b = bySpell.get(k) || { spell: k, cast: 0, produced: 0, nothing: 0,
                                  mana_spent: 0, characters: new Set(), why: {} };
    b.cast++;
    if (e.ok) b.produced++; else b.nothing++;
    b.mana_spent += Number(e.mana_cost) || 0;
    if (e.character) b.characters.add(e.character);
    if (e.why) b.why[e.why] = (b.why[e.why] || 0) + 1;
    bySpell.set(k, b);
  }
  // A spell that was ONLY ever declined has no cast row, and that is the most
  // interesting row there is — it is the difference between "this loop is failing" and
  // "this loop never started". Give it one.
  for (const e of declines) {
    const k = e.spell || 'unknown';
    if (!bySpell.has(k))
      bySpell.set(k, { spell: k, cast: 0, produced: 0, nothing: 0, mana_spent: 0,
                       characters: new Set(), why: {} });
    if (e.character) bySpell.get(k).characters.add(e.character);
  }

  // Declines are rate-limited to one line per ten minutes per (spell, reason), so the
  // LINE count is meaningless and `times_so_far` is the real one — it is that keeper's
  // running total. Take the largest seen per character, then add them up: keepers are
  // restarted often and each restart starts its own count from zero, so summing every
  // line would multiply, and taking one would drop every character but the last.
  const declineTotals = new Map();
  for (const e of declines) {
    const key = (e.spell || 'unknown') + ' | ' + (e.why || 'unspecified');
    const per = declineTotals.get(key) || new Map();
    const seen = per.get(e.character) || 0;
    per.set(e.character, Math.max(seen, Number(e.times_so_far) || 1));
    declineTotals.set(key, per);
  }

  // `item_kind`, not `kind` — `kind` on one of these records is always 'bought', which
  // is how the filter above found it. See recordEvent.
  const kinds = {};
  for (const e of buys) {
    const k = e.item_kind || 'other';
    const v = kinds[k] || (kinds[k] = { items: 0, spent: 0 });
    v.items++; v.spent += Number(e.cost) || 0;
  }

  const perChar = new Map();
  const charOf = (n) => {
    let v = perChar.get(n);
    if (!v) perChar.set(n, v = { character: n, cast: 0, produced: 0, spent: 0, bought: 0 });
    return v;
  };
  for (const e of casts) {
    if (!e.character) continue;
    const v = charOf(e.character);
    v.cast++; if (e.ok) v.produced++;
  }
  for (const e of buys) {
    if (!e.character) continue;
    const v = charOf(e.character);
    v.bought++; v.spent += Number(e.cost) || 0;
  }

  const spells = [...bySpell.values()].map(b => ({
    spell: b.spell, cast: b.cast, produced: b.produced, nothing: b.nothing,
    worked: b.cast ? Math.round(100 * b.produced / b.cast) + '%' : null,
    mana_spent: b.mana_spent || undefined,
    characters: b.characters.size,
    reasons: Object.entries(b.why).sort((a, b2) => b2[1] - a[1])
                   .map(([w, n]) => ({ why: w, times: n })),
  })).sort((a, b) => b.cast - a.cast);

  return {
    window_hours: +(sinceMs / 3600000).toFixed(1),
    ...(character ? { character } : {}),
    by_spell: spells,
    declined: [...declineTotals.entries()].map(([key, per]) => {
      const [spell, why] = key.split(' | ');
      return { spell, why, times: [...per.values()].reduce((a, b) => a + b, 0),
               characters: per.size };
    }).sort((a, b) => b.times - a.times),
    purchases: {
      total_spent: Object.values(kinds).reduce((a, v) => a + v.spent, 0),
      by_kind: Object.entries(kinds).map(([kind, v]) => ({ kind, items: v.items, spent: v.spent })),
      // The direct answer to "are they buying food or reagents", stated rather than
      // left to be inferred from an absent row.
      bought_food: !!kinds.food,
      bought_reagents: !!(kinds.elderberry || kinds.herb),
      never_offered_food:
        'nothing in the fleet can buy prepared food. restockReagents filters a ' +
        'merchant\'s list through skills.SHAREABLE, which contains elderberry and ' +
        'herbs and nothing else — so an empty larder is only ever answered by casting ' +
        'or by looting. If food should be purchasable, that list is where to add it.',
      why_declined: [...new Set(buyDeclines.map(e => e.why))].slice(0, 8),
    },
    by_character: [...perChar.values()]
      .map(v => ({ ...v, worked: v.cast ? Math.round(100 * v.produced / v.cast) + '%' : null }))
      .sort((a, b) => b.cast - a.cast),
    recent: casts.slice(-25).reverse().map(e => ({
      at: e.iso || new Date(e.t).toISOString(), character: e.character,
      spell: e.spell, ok: e.ok, why: e.why,
      ...(e.made ? { made: e.made } : {}), ...(e.target ? { target: e.target } : {}),
      ...(e.reagents_before ? { reagents_before: e.reagents_before } : {}),
    })),
    read_this_way:
      '`worked` is the percentage of casts that produced something, and it is the only ' +
      'field that distinguishes a supply loop from a character wasting mana — neither ' +
      'spell reports its own failure. `declined` is why a cast did NOT happen, and a ' +
      'spell appearing there with cast: 0 means the loop never started rather than that ' +
      'it is failing. `times` in declined is summed from each keeper\'s own running ' +
      'count, so a broker restart resets it and the total is a floor, not an exact figure.',
  };
}

// Where the fleet's time actually goes. Stalled means standing about not knowing what
// to do, while NOT recovering — resting and eating are work.
export function timeReport({ sinceMs = 24 * 3600 * 1000 } = {}) {
  const { samples, events } = readLedger({ sinceMs });
  const latest = new Map();
  for (const s of samples) if (s.active_s != null) latest.set(s.character, s);
  const rows = [...latest.values()].map(s => ({
    character: s.character, strategy: s.strategy,
    active_s: s.active_s, stalled_s: s.stalled_s, stalled_pct: s.stalled_pct,
    fighting_s: s.fighting_s, pulling_s: s.pulling_s, waiting_s: s.waiting_s,
    recovering_s: s.recovering_s, zoning_s: s.zoning_s, travelling_s: s.travelling_s,
  })).sort((a, b) => (b.stalled_pct ?? 0) - (a.stalled_pct ?? 0));

  const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const stalls = {};
  for (const e of events.filter(e => e.kind === 'stalled'))
    stalls[e.why] = (stalls[e.why] || 0) + 1;
  const resolutions = {};
  for (const e of events.filter(e => e.kind === 'unstalled'))
    resolutions[`${e.after} -> ${e.moved ? 'moved room' : 'resolved in place'}`] =
      (resolutions[`${e.after} -> ${e.moved ? 'moved room' : 'resolved in place'}`] || 0) + 1;

  const total = sum('active_s') + sum('stalled_s');
  return {
    fleet: { active_s: sum('active_s'), stalled_s: sum('stalled_s'),
             stalled_pct: total ? +((100 * sum('stalled_s')) / total).toFixed(1) : 0,
             fighting_s: sum('fighting_s'), recovering_s: sum('recovering_s'),
             pulling_s: sum('pulling_s'), waiting_s: sum('waiting_s'),
             zoning_s: sum('zoning_s'),
             travelling_s: sum('travelling_s') },
    worst_offenders: rows.slice(0, 8),
    stall_causes: Object.entries(stalls).sort((a, b) => b[1] - a[1])
      .map(([why, n]) => ({ why, times: n })),
    how_stalls_ended: Object.entries(resolutions).sort((a, b) => b[1] - a[1])
      .map(([what, n]) => ({ what, times: n })),
  };
}

// Per character: where it started, where it got to, and what happened on the way.
export function summarise({ sinceMs = 24 * 3600 * 1000 } = {}) {
  const { samples, events } = readLedger({ sinceMs });
  // Counted here rather than fetched, because this function is already holding the
  // events killsIn() would have re-read the day files for.
  const recentKills = countKills(events, Date.now() - KILL_WINDOW_MS);
  const by = new Map();
  for (const s of samples) {
    const e = by.get(s.character) || {
      character: s.character, first_seen: s.t, last_seen: s.t,
      level_first: s.level, level_last: s.level, level_peak: s.level ?? 0,
      kills_last: s.kills, room_last: s.room, samples: 0,
    };
    e.last_seen = s.t;
    // IS THIS A READING, OR A NOTE THAT WE COULD NOT TAKE ONE?
    //
    // A character that is not in game still gets sampled every thirty seconds, and
    // every field of that sample is null. That is honest — we genuinely do not know
    // anything right now — but it is not new information about the CHARACTER, whose
    // state is frozen: a logged-off character is out of the world entirely, so
    // nothing can move it, hurt it or heal it until it logs back in.
    //
    // So an offline sample must never overwrite a real one. It records only that we
    // stopped being able to see, and when.
    const offline = s.stalled === 'not in game';
    if (!offline) e.last_in_game = s.t;
    e.online = !offline;
    // Last KNOWN level, not last sampled. Every other column below already falls back
    // this way; this one did not, so an offline fleet reported a page of characters
    // with no levels — which reads as "they are all level nothing" rather than "we
    // cannot see them", and takes `gained` and the strategy comparison down with it.
    e.level_last = s.level ?? e.level_last ?? null;
    // Likewise the baseline: if the first sample of the window was taken mid-login or
    // while offline it has no level, and `gained` would be measured from zero.
    e.level_first ??= s.level ?? null;
    // MEASURE EACH CHARACTER FROM WHEN ITS CURRENT STRATEGY STARTED, not from the
    // beginning of the window. Ten hours of pre-experiment history — including a
    // spell trapped in a sealed town and a run of deaths caused by a safety rule that
    // turned out to be wrong — would otherwise be charged against whichever pattern
    // the character happens to be running now, which is exactly backwards.
    if (s.strategy && s.strategy !== e.strategy) {
      e.strategy = s.strategy;
      e.strategy_since = s.t;
      e.level_at_strategy = s.level;
    }
    if (e.strategy) e.level_now_in_strategy = s.level;
    if ((s.level ?? 0) > e.level_peak) e.level_peak = s.level ?? 0;
    e.kills_last = Math.max(e.kills_last ?? 0, s.kills ?? 0);
    // LAST KNOWN, not last sampled. A snapshot taken while a character is mid-login
    // reports no room at all, and overwriting with that blanks the column for every
    // character on the page for the first few minutes after a restart — which reads
    // as "the fleet is nowhere" rather than "we have not heard yet".
    e.room_last = s.room ?? e.room_last ?? null;
    // LATEST, not aggregated. Health and mana are the two things on this page that
    // are only meaningful as "right now" — an average health is a number about
    // nothing. Samples are read in time order, so the last write wins.
    e.room_num_last = s.room_num ?? e.room_num_last ?? null;
    e.health_last = s.health ?? e.health_last ?? null;
    e.mana_last = s.mana ?? e.mana_last ?? null;
    e.vigor_last = s.vigor_of ?? e.vigor_last ?? null;
    e.weapon_last = s.has_weapon ?? e.weapon_last ?? null;
    e.food_last = s.has_food ?? e.food_last ?? null;
    e.activity_last = s.activity ?? e.activity_last ?? null;
    e.learning_last = s.learning_progress ?? e.learning_last ?? null;
    e.planned_learning_last = s.planned_learning ?? e.planned_learning_last ?? null;
    // Counters, so take the largest seen rather than the latest — a keeper restart
    // zeroes them and the point of the column is the run, not the process.
    e.spot_deaths = Math.max(e.spot_deaths ?? 0, s.deaths_in_safe_spot ?? 0);
    e.proven_spot_deaths = Math.max(e.proven_spot_deaths ?? 0, s.deaths_in_proven_safe_spot ?? 0);
    e.mulligans = Math.max(e.mulligans ?? 0, s.mulligans ?? 0);
    e.logoffs = Math.max(e.logoffs ?? 0, s.logoffs ?? 0);
    e.samples++;
    by.set(s.character, e);
  }
  for (const ev of events) {
    const e = by.get(ev.character);
    if (!e) continue;
    e.events ??= {};
    e.events[ev.kind] = (e.events[ev.kind] || 0) + 1;
    // Deaths under the CURRENT strategy — the only ones that say anything about it.
    if (ev.kind === 'died' && e.strategy_since && ev.t >= e.strategy_since)
      e.deaths_in_strategy = (e.deaths_in_strategy || 0) + 1;
  }
  const rows = [...by.values()].map(e => ({
    character: e.character,
    level: e.level_last,
    gained: (e.level_last ?? 0) - (e.level_first ?? 0),
    peak: e.level_peak,
    kills: e.kills_last,
    // The two kill columns are on different clocks and neither is the other's rate.
    // `kills` is a high-water mark over the whole window, taken with Math.max above
    // because a keeper restart zeroes the counter; this one is a count of what was
    // actually recorded in the last half hour. A row can honestly show 134 and 0.
    kills_30m: recentKills.get(e.character) ?? 0,
    deaths: e.events?.died || 0,
    stalls: e.events?.stalled || 0,
    left_newbie_zone: !!e.events?.left_the_newbie_zone,
    room: e.room_last,
    room_num: e.room_num_last ?? null,
    // Everything to the right of here may be a memory rather than a reading. `online`
    // says which, and `last_in_game` says how old the memory is, so a page can show
    // the state as it was instead of a row of dashes.
    online: e.online !== false,
    last_in_game: e.last_in_game ?? null,
    health: e.health_last ?? null,
    mana: e.mana_last ?? null,
    vigor: e.vigor_last ?? null,
    has_weapon: e.weapon_last ?? null,
    has_food: e.food_last ?? null,
    activity: e.activity_last ?? null,
    learning: e.learning_last ?? null,
    planned_learning: e.planned_learning_last ?? null,
    deaths_in_safe_spot: e.spot_deaths ?? 0,
    deaths_in_proven_safe_spot: e.proven_spot_deaths ?? 0,
    mulligans: e.mulligans ?? 0,
    logoffs: e.logoffs ?? 0,
    strategy: e.strategy ?? null,
    watched_hours: +((e.last_seen - e.first_seen) / 3600000).toFixed(2),
    // The experimental measurements: everything since this character's current
    // pattern began, and nothing before it.
    on_strategy_hours: e.strategy_since ? +((e.last_seen - e.strategy_since) / 3600000).toFixed(2) : 0,
    gained_on_strategy: e.strategy_since
      ? (e.level_now_in_strategy ?? 0) - (e.level_at_strategy ?? 0) : 0,
    deaths_on_strategy: e.deaths_in_strategy || 0,
  })).sort((a, b) => (b.level ?? 0) - (a.level ?? 0));

  // THE COMPARISON. Health gained per hour is the figure that decides which pattern
  // is better; kills are not, because a kill at or below your own level is worth
  // nothing at all and a strategy can look busy while gaining no ground.
  const byStrategy = {};
  for (const r of rows) {
    const k = r.strategy || 'unassigned';
    const g = byStrategy[k] ??= { strategy: k, characters: 0, levels_gained: 0,
                                  deaths: 0, stalls: 0, hours: 0, kills: 0 };
    g.characters++;
    g.levels_gained += Math.max(0, r.gained_on_strategy);
    g.deaths += r.deaths_on_strategy;
    g.stalls += r.stalls;
    g.kills += r.kills || 0;
    g.hours += r.on_strategy_hours;
  }
  const comparison = Object.values(byStrategy).map(g => ({
    ...g,
    hours: +g.hours.toFixed(2),
    levels_per_hour: g.hours ? +(g.levels_gained / g.hours).toFixed(3) : null,
    deaths_per_hour: g.hours ? +(g.deaths / g.hours).toFixed(3) : null,
  })).sort((a, b) => (b.levels_per_hour ?? 0) - (a.levels_per_hour ?? 0));

  // WHEN DID WE LAST SEE ANY OF THEM?
  //
  // The banner is about the fleet, not about one character, so the moment that
  // matters is the last time ANYBODY was in game — that is when the connection went,
  // and counting from any individual character's last sighting would start the clock
  // early for whoever dropped first.
  const online = rows.filter(r => r.online);
  const lastAnyone = rows.reduce((m, r) => Math.max(m, r.last_in_game ?? 0), 0) || null;

  return {
    window_hours: +(sinceMs / 3600000).toFixed(1),
    characters: rows.length,
    online: online.length,
    // Null while anyone is still in game. A timestamp means the whole fleet is dark
    // and this is when it went dark.
    offline_since: online.length === 0 ? lastAnyone : null,
    last_in_game: lastAnyone,
    // WHEN DID A SAMPLE LAST ARRIVE AT ALL — in game or not.
    //
    // `offline_since` can only be set by something that is still running and still
    // writing "not in game" every thirty seconds. If the BROKER dies, nobody writes
    // anything, every character's last sample is a healthy one, and the page would
    // report a fleet in perfect condition for ever. The age of the newest sample is
    // the one signal that survives the reporter itself going away.
    last_sample_at: samples.reduce((m, s) => Math.max(m, s.t ?? 0), 0) || null,
    samples: samples.length,
    total_levels_gained: rows.reduce((a, r) => a + Math.max(0, r.gained), 0),
    total_deaths: rows.reduce((a, r) => a + r.deaths, 0),
    fleet: rows,
    comparison,
    comparison_note: 'levels_per_hour is the figure that matters — max health IS the ' +
      'level, and it is what every one of these patterns is trying to buy. Read ' +
      'deaths_per_hour next: a death costs a point of max health outright, so a fast ' +
      'pattern that dies is not fast.',
    recent_events: events.slice(-40).map(e => ({ at: e.iso || new Date(e.t).toISOString(),
                                                 character: e.character, kind: e.kind,
                                                 ...Object.fromEntries(Object.entries(e)
                                                   .filter(([k]) => !['t', 'iso', 'type', 'character', 'kind'].includes(k))) })),
  };
}
