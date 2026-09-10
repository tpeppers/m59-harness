// READING THE DEATHS BACK — and refusing to answer where most of them happened.
//
//   node tools/m59-postmortems.mjs              what the corpus says, and what it will not say
//   node tools/m59-postmortems.mjs --since 24h
//
// The keeper writes a file per death under substrate/postmortems/. There are 637 of them
// as this is written and they are the richest record in the repository — frames, server
// text, keeper decisions, damage segments. They are also, on the question everyone asks
// first, WRONG ABOUT HALF THE TIME, and nothing about reading one tells you which half.
//
// TWO QUESTIONS, TWO COMPLETELY DIFFERENT EVIDENTIARY SITUATIONS.
//
// WHAT KILLED IT is answered by the server, out loud, to the whole world:
// "### Zoot was just killed by a groundworm." (system.kod:49-57, caught as
// `killed_by_broadcast`). That is an observation. When it is missing, the fallback is
// "what was standing next to us at the end" — which was measured against the 249 deaths
// that DO have a broadcast and was right 51% of the time. A coin flip. So the two are
// never mixed here: `observed: true` or the killer is a guess and says so.
//
// WHERE IT DIED is answered by nobody, and this is the part that produced fiction. The
// keeper reconstructs the death from its own last frame, and a keeper pass can be a
// single `await` lasting minutes — Session.travel loops up to 25 hops with no observation
// in it at all. So the record names the last place anybody looked, which is frequently a
// town the character walked out of. Measured over the whole corpus: the last frame is
// more than a minute stale in 203 of 624 deaths, worst case 17 minutes.
//
// THAT IS WHY THE RECORDS NAME INNS. Nobody died in an inn. Nothing in an inn can hurt
// you. "Familiars", "The Limping Toad Inn and Tavern" and "Yonder Inn of Jasper" between
// them hold 37 deaths in the raw data and every one of them is a lie of omission — the
// character was resting there when the keeper last looked, and died somewhere else.
//
// SO A LOCATION IS EVIDENCE OR IT IS NOTHING. It is trusted only when an independent
// observation lands within TRUST_MS of the killing blow, and there are two such witnesses:
//
//   hits    damage segments, off the EVENT STREAM. The server pushes health changes
//           whether or not the keeper is looking, so this keeps recording through a
//           travel, an errand, or an inert keeper. It is the strongest witness there is:
//           it says which square the damage landed on. Only recent deaths have it.
//   frame   the keeper's own last observation. Fine when it is fresh, worthless when it
//           is not, and the whole problem is that those look identical.
//
// The window was chosen by measurement rather than taste. Against all 637:
//
//     window   kept   inns/shops kept   rooms with no spawn table
//     15s       260          0                     0
//     30s       384          0                     0
//     60s       459          1                     0
//    120s       537          3                     0
//
// 30s keeps 60% of the corpus and leaks nothing that cannot kill you. 60s starts letting
// inns back in, which is the exact failure this exists to prevent, so the extra 75 deaths
// are not worth having. The other 253 are not deleted — they are reported as UNPLACED,
// with a count, because "we do not know where 253 of these happened" is a finding and
// silently dropping them would hide it.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const POSTMORTEM_DIR = process.env.M59_POSTMORTEM_DIR || here('../substrate/postmortems');

// ------------------------------------------------------ WHICH TREE'S DEATHS, AND SAYING SO
//
// A KEEPER WRITES ITS POSTMORTEMS INTO THE CHECKOUT IT IS RUNNING FROM, AND THAT IS USUALLY
// NOT THE CHECKOUT YOU ARE READING FROM.
//
// `POSTMORTEM_DIR` above resolves to THIS tree. That is right for the writer — the autopilot
// does the same thing at m59-autopilot.mjs:117 — and wrong for every reader, because prod is a
// separate worktree (`C:\code\m59-lab\prod-deploy`, see CLAUDE.md § PROD IS A VERSIONED DEPLOY
// OF MAIN) and development happens somewhere else.
//
// MEASURED 2026-09-10, and it is the reason this exists. `m59-critic.mjs travel --since 12h`,
// run from the mindmap checkout, printed:
//
//     0 candidate(s); 0 exempt as PVP; 0 default to DEFECT.
//       nothing in the window.
//
// The prod fleet had died FORTY-FOUR TIMES in those twelve hours. The critic had read
// `<this tree>/substrate/postmortems`, whose newest record was eleven days old, and reported
// the empty answer with no more hesitation than a true one. That is the exact failure the
// memory note "verify the value, not the instrument" is about: the question was never asked of
// the fleet, and nothing in the output said so.
//
// SO THE STORE IS RESOLVED, NOT ASSUMED, AND THE ANSWER CARRIES ITS ADDRESS. Same shape and the
// same precedence rule as every other fleet resolution in this repository (CLAUDE.md § Which
// fleet), most explicit first:
//
//     explicit          what this invocation said        (--postmortems <dir>)
//     M59_POSTMORTEM_DIR  what this shell said
//     the live broker   what is actually holding the fleet, off its own /health
//     this checkout     what it has always been
//
// THE BROKER RUNG IS WHY THIS IS A FIX AND NOT A FLAG. An env var only helps somebody who
// already knows they are in the wrong tree, which is precisely what today's failure proves
// nobody knows. A broker answers `state` — the roster file it is serving — and CLAUDE.md is
// explicit that the state path, never the fleet label, is what identifies a broker as ours.
// Its `substrate` ancestor is the tree the keepers are writing deaths into.
//
// AND IT IS ADVISORY, NEVER LOAD-BEARING. Forensics happen most often when the fleet is DOWN,
// so a probe that cannot answer must cost nothing: it is time-boxed, every failure is
// swallowed, and the local store is still there underneath. What the caller must not do is
// drop the `why` and the `records` count on the floor — an empty window that cannot name the
// directory it read is the bug this whole block exists to stop reissuing.

const BROKER_PROBE_MS = Number(process.env.M59_POSTMORTEM_PROBE_MS || 700);

// The `substrate` ancestor of a path, which is what a roster or a root resolves to. Returns
// null rather than guessing: a path with no `substrate` in it is a broker we do not understand,
// and inventing a directory for it would be the same class of quiet wrongness as the bug above.
export function substrateOf(p) {
  if (!p) return null;
  const parts = resolve(String(p)).split(/[\\/]/);
  const i = parts.lastIndexOf('substrate');
  return i < 0 ? null : parts.slice(0, i + 1).join(sep);
}

// How many records a store holds and how new the newest is, read from the FILENAMES — the same
// trick readPostmortems uses for its window, and it means a candidate store costs a readdir
// rather than several thousand JSON parses.
export function storeStats(dir) {
  if (!dir || !existsSync(dir)) return { dir, exists: false, records: 0, newest: null };
  let names;
  try { names = readdirSync(dir).filter(f => f.endsWith('.json')); }
  catch { return { dir, exists: false, records: 0, newest: null }; }
  let newest = null;
  for (const f of names) {
    const m = f.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/);
    if (!m) continue;
    const t = Date.parse(m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z'));
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return { dir, exists: true, records: names.length, newest };
}

// The ports worth asking. The default first — one broker on 8901 is the ordinary case — then
// anything a local `broker-*.pid` names, which is how a second fleet on this machine is found.
// Mirrors candidateBrokerPorts() in m59-fleets.mjs; that file cannot be imported because it
// runs its main and calls process.exit at load.
function candidateBrokerPorts() {
  const ports = [Number(process.env.M59_BROKER_PORT || 8901)];
  const sub = here('../substrate');
  if (existsSync(sub)) {
    for (const file of readdirSync(sub)) {
      if (!/^broker-.+\.pid$/.test(file)) continue;
      try {
        const port = Number(JSON.parse(readFileSync(join(sub, file), 'utf8'))?.http);
        if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
      } catch { /* a pid file we cannot read is a lost hint, not a failure */ }
    }
  }
  return [...new Set(ports.filter(p => Number.isInteger(p) && p > 0 && p < 65536))];
}

function askHealth(port, timeoutMs) {
  return new Promise((done) => {
    const finish = (v) => { try { req.destroy(); } catch { /* already gone */ } done(v); };
    const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET',
                               timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1e6) finish(null); });
      res.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => finish(null));
    req.end();
  });
}

// Every store this machine can offer, ordered most-authoritative-first, each carrying WHY it is
// a candidate and what is in it. The caller reads [0] and is expected to print the rest when the
// window comes back empty.
export async function resolvePostmortemStores({ explicit = null, probe = true,
                                                timeoutMs = BROKER_PROBE_MS } = {}) {
  const out = [];
  const seen = new Set();
  const add = (dir, why) => {
    if (!dir) return;
    const key = resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...storeStats(resolve(dir)), why });
  };

  if (explicit) add(explicit, '--postmortems');
  if (process.env.M59_POSTMORTEM_DIR) add(process.env.M59_POSTMORTEM_DIR, 'M59_POSTMORTEM_DIR');

  if (probe) {
    const ports = candidateBrokerPorts();
    const healths = await Promise.all(ports.map(p => askHealth(p, timeoutMs).catch(() => null)));
    for (let i = 0; i < ports.length; i += 1) {
      const h = healths[i];
      if (!h) continue;
      // `state` before `root`: the roster path is what CLAUDE.md makes the identity of a
      // broker, and `root` is only a hint about where it was started from. `root` is a TREE
      // and carries no `substrate` segment to find, so it is joined rather than scanned —
      // `substrateOf(root)` is null by construction and reading it as a fallback would make
      // this rung quietly dead.
      const sub = substrateOf(h.state) ?? (h.root ? join(resolve(String(h.root)), 'substrate') : null);
      if (sub) add(join(sub, 'postmortems'),
                   `the broker on ${ports[i]} holding fleet "${h.fleet || 'default'}"`);
    }
  }

  add(POSTMORTEM_DIR, 'this checkout');
  return out;
}

// How fresh an observation has to be to place a death. See the table above.
export const TRUST_MS = Number(process.env.M59_DEATH_TRUST_MS || 30_000);

// HOW LONG A KEEPER MAY GO WITHOUT LOOKING BEFORE IT COUNTS AS BLIND.
//
// Not a taste threshold: 8s is the keeper's own `resyncMs` default — the longest it is
// DESIGNED to go without re-asking the server for the room and the stats. Past that it is
// operating outside its own envelope, whatever the uptime ledger says about it being up.
// The decide loop turns every 1s by default and writes a frame each pass, so an 18s gap is
// roughly eighteen decisions taken against a view of the world that never changed.
//
// Deliberately NOT the same number as TRUST_MS, which answers a different question. 30s is
// how stale a reading may be before it stops being evidence about WHERE; this is how stale
// it may be before the keeper stops being able to ACT. A character can bleed out well
// inside a window that still places it correctly — Camilla did, at 17.8s.
export const WATCH_MS = Number(process.env.M59_KEEPER_WATCH_MS || 8_000);

// ------------------------------------------------------------------ what killed it

export function causeOf(pm) {
  const b = pm?.killed_by_broadcast;
  if (b?.killer)
    return { killer: b.killer, observed: true, how: b.how ?? 'killed', said: b.text ?? null,
             why: 'the server announced it to the world' };
  // The fallback, and it is labelled rather than dressed up. `was_nearby` is what the
  // keeper could see at the end; the most-common member of that crowd was the real
  // killer in 51% of the deaths where both were available.
  const crowd = pm?.summary?.was_nearby ?? pm?.threats?.present_at_the_end ?? [];
  if (!crowd.length)
    return { killer: null, observed: false, how: null, said: null,
             why: 'no broadcast reached us and nothing was in view at the end' };
  const tally = new Map();
  for (const c of crowd) tally.set(c, (tally.get(c) || 0) + 1);
  const top = [...tally.entries()].sort((a, b2) => b2[1] - a[1])[0][0];
  return { killer: top, observed: false, how: null, said: null, crowd,
           why: 'no broadcast — this is only the commonest thing standing nearby, which ' +
                'matches the real killer about half the time' };
}

// ------------------------------------------------------------------ where it died

export function locate(pm) {
  const death = pm?.at ?? null;
  if (death == null) return { trusted: false, why: 'no time of death recorded' };

  // The event stream first. A hit segment is the only witness that keeps working while
  // the keeper is blind, and it names the square rather than the room.
  const hit = (pm.hits || [])
    .filter(h => h?.room != null && h.last_at != null)
    .sort((a, b) => a.last_at - b.last_at).slice(-1)[0];
  if (hit && death - hit.last_at <= TRUST_MS && death - hit.last_at >= -TRUST_MS)
    return { trusted: true, source: 'hits', room: hit.room_name ?? null, num: hit.room,
             col: hit.col ?? null, row: hit.row ?? null,
             stale_ms: death - hit.last_at,
             why: 'damage landed here, off the event stream, ' +
                  `${Math.round((death - hit.last_at) / 100) / 10}s before the killing blow` };

  const frame = (pm.frames || []).filter(f => f?.at != null).sort((a, b) => a.at - b.at).slice(-1)[0];
  if (frame && death - frame.at <= TRUST_MS)
    return { trusted: true, source: 'frame', room: frame.room ?? null, num: frame.num ?? null,
             col: frame.col ?? null, row: frame.row ?? null,
             stale_ms: death - frame.at, threats: frame.threat_count ?? 0,
             why: `the keeper was looking ${Math.round((death - frame.at) / 100) / 10}s before it died` };

  // Everything else. The recorded room is carried so a reader can see WHAT the guess
  // would have been, clearly marked as not evidence.
  const stale = frame ? death - frame.at : null;
  return {
    trusted: false, source: null,
    claimed: pm.summary?.died_in ?? pm.where?.room ?? null,
    claimed_num: pm.summary?.room_num ?? pm.where?.num ?? null,
    stale_ms: stale,
    why: stale == null ? 'the keeper never got a frame for this death'
       : `the last time anybody looked was ${Math.round(stale / 1000)}s before it died — ` +
         'that is where it WAS, not where it died',
  };
}

// ------------------------------------------------------------- was anything driving?
//
// "WAS THE KEEPER UP" IS TWO QUESTIONS AND THE SECOND ONE IS THE USEFUL ONE.
//
// A character whose keeper stopped stands still in whatever fight it was in, and reading
// that as a hunting decision charges the strategy for an operator restart. So the uptime
// ledger is checked and the answer goes on the row. That much is a plain Y/N.
//
// But a keeper can be up, driving, and NOT LOOKING, and this is the far more common and
// far more dangerous state. A pass can be a single `await` lasting minutes — a travel
// loops up to 25 hops with no observation in it — so the keeper's last frame is routinely
// tens of seconds old at the moment of death. Camilla died with the keeper continuously
// up for sixteen minutes either side, and blind for the last 17.8 seconds of it: her final
// frame reads 22/29, comfortably above her own flee threshold, while the event stream
// recorded her going 22 -> 19 -> 18 -> 16 -> 14 -> 11 -> 10 -> 5 -> 4 -> 0 in the interval.
// The keeper never saw a number it would have fled from, because it never looked.
//
// A bare Y there is true and useless. So Y carries how long it had been blind, and the
// page colours it: a keeper that was watching is not the same as one that was merely
// running.
function handbrakeOf(pm, outage) {
  if (outage)
    return { known: true, fired: false,
             why: 'there was no keeper running, so there was no handbrake to fire' };
  const w = pm?.summary?.watchdog ?? null;
  if (!w) return { known: false, why: 'this death predates the watchdog being recorded' };
  if (w.running === false) return { known: true, fired: false, why: 'no watchdog on that keeper' };
  if (w.stood_down_for)
    return { known: true, fired: false, stood_down_for: w.stood_down_for,
             why: `the watchdog stood down — ${w.stood_down_for} — so it was never allowed to act` };
  if (w.interrupted_this_pass)
    return { known: true, fired: true, blocked_ms: w.pass_blocked_ms,
             why: 'the watchdog DID interrupt the pass this character died in, and it died anyway' };
  return { known: true, fired: false, blocked_ms: w.pass_blocked_ms,
           why: 'the watchdog was running and never interrupted this pass — health did not '
              + 'cross the flee line while it was watching' };
}

export function keeperOf(pm) {
  const outage = pm?.during_keeper_outage ?? null;
  const frame = (pm?.frames || []).filter(f => f?.at != null).sort((a, b) => a.at - b.at).slice(-1)[0];
  const blind_ms = frame && pm?.at != null ? pm.at - frame.at : null;
  // COMPUTED BEFORE THE EARLY RETURNS, and included in all three of them.
  //
  // It was computed after, so the two branches that return early — died during a keeper
  // outage, and no frames at all — carried `handbrake: undefined`. That is the same
  // failure this field exists to fix, one level up: `undefined` reads as "did not fire"
  // to anything that does not check, when the truth for an outage is "there was no keeper
  // to fire it".
  const handbrake = handbrakeOf(pm, outage);
  if (outage)
    return { up: false, blind_ms, outage, handbrake,
             why: `nothing was driving — the keeper had been down ${Math.round((outage.ms ?? 0) / 1000)}s` };
  if (blind_ms == null)
    return { up: null, blind_ms: null, outage: null, handbrake,
             why: 'no uptime record and no frames — cannot say either way' };
  // WHAT THE HANDBRAKE DID, when the record carries it. Three deaths that look identical
  // from outside — "died travelling, keeper blind" — are three different faults:
  //   fired and died anyway  the interrupt is not enough; it cancels a walk and the next
  //                          pass still has to survive long enough to decide
  //   never fired            health never crossed the flee line before the end, so a
  //                          level trigger was the wrong instrument (see the burst deaths)
  //   stood down             an errand owned the character and the watchdog returns early
  // Absent on every death recorded before the watchdog was written into the postmortem,
  // and reported as UNKNOWN rather than as "did not fire" — the two are not the same and
  // reading one as the other is how a fix gets aimed at the wrong half.
  return {
    up: true, blind_ms, outage: null,
    watching: blind_ms <= WATCH_MS,
    handbrake,
    why: blind_ms <= WATCH_MS
      ? `the keeper was up and had looked ${Math.round(blind_ms / 100) / 10}s before the end`
      : `the keeper was UP BUT BLIND — it had not observed this character for ` +
        `${Math.round(blind_ms / 1000)}s when it died, past its own 8s resync interval, so ` +
        'nothing it decided in that window was based on the character\'s real state',
  };
}

// ------------------------------------------------------------------ loading

const parse = (file, dir = POSTMORTEM_DIR) => {
  try { return JSON.parse(readFileSync(join(dir, file), 'utf8')); }
  catch { return null; }
};

// Every death, newest first, with the two judgements already made. `frames`, `text` and
// `decisions` are the bulk of the file and are NOT carried — a list of 600 deaths with
// full frame logs is 40MB and the page wants a table. `digest()` re-reads one on demand.
// `dir` defaults to POSTMORTEM_DIR so every existing caller is unchanged. A reader that wants the
// fleet's deaths rather than this tree's passes one from resolvePostmortemStores.
export function loadPostmortems({ sinceMs = null, limit = 5000, dir = POSTMORTEM_DIR } = {}) {
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const cutoff = sinceMs ? Date.now() - sinceMs : null;
  const out = [];
  for (const f of files) {
    const pm = parse(f, dir);
    if (!pm?.at) continue;
    if (cutoff && pm.at < cutoff) continue;
    const where = locate(pm), cause = causeOf(pm);
    out.push({
      file: f, at: pm.at, character: pm.character ?? null, agent: pm.agent ?? null,
      level: pm.summary?.level ?? pm.vitals?.level ?? null,
      strategy: pm.was?.strategy ?? null,
      hunting: pm.was?.hunting ?? null,
      doing: pm.was?.doing ?? null,
      in_safe_spot: !!pm.was?.in_safe_spot,
      during_keeper_outage: pm.during_keeper_outage ?? null,
      cause, where, keeper: keeperOf(pm),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

// ONE DEATH, READ PROPERLY. This is what the log's click-through opens, and it is a
// summary rather than the file: the file is the full flight recorder and the question a
// person actually has is "what happened", which is six lines.
export function digest(file) {
  const pm = parse(file);
  if (!pm) return null;
  const where = locate(pm), cause = causeOf(pm);
  const frames = pm.frames || [];
  const last = frames.slice(-1)[0];

  // The health trail says whether this was a slide or a cliff, and they are different
  // deaths: a slide is a keeper that did not withdraw, a cliff is a crowd that got a
  // round in. Rendered from the trail rather than described, because the shape is the
  // finding.
  const trail = pm.vitals?.trail ?? [];
  const level = pm.summary?.level ?? pm.vitals?.level ?? null;
  const drops = [];
  for (let i = 1; i < trail.length; i++) if (trail[i] < trail[i - 1]) drops.push(trail[i - 1] - trail[i]);
  const worst = drops.length ? Math.max(...drops) : 0;

  // What the server said, trimmed to the fighting. A postmortem's text log runs to
  // hundreds of lines of merchant chatter; the last twenty before death are the ones
  // that describe it.
  const text = (pm.text || []).filter(t => t?.text).slice(-24)
    .map(t => ({ at: t.at, text: t.text, dt: pm.at - t.at }));

  return {
    file, character: pm.character, agent: pm.agent, at: pm.at, level,
    cause, where, keeper: keeperOf(pm),
    was: {
      doing: pm.was?.doing ?? null, hunting: pm.was?.hunting ?? null,
      strategy: pm.was?.strategy ?? null, in_safe_spot: !!pm.was?.in_safe_spot,
      vigor: pm.vitals?.last_vigor ?? null,
    },
    // THE ONE NUMBER THAT SAYS WHETHER THE KEEPER HAD A CHANCE. A death from full health
    // in one step is nothing a flee threshold could have caught; a slow slide past the
    // threshold is a keeper that did not act on its own rule.
    shape: worst >= (level ?? 0) * 0.5 ? 'one big hit' : drops.length > 2 ? 'a slide' : 'a few hits',
    biggest_drop: worst,
    health_trail: trail,
    flee_threshold: pm.summary?.flee_threshold ?? pm.vitals?.flee_threshold ?? null,
    fled_in_time: pm.summary?.fled_in_time ?? null,
    threats: pm.threats?.present_at_the_end ?? [],
    most_at_once: pm.threats?.most_at_once ?? null,
    players_present: pm.threats?.players_present ?? [],
    // DID THIS HAPPEN AT A SAFE WALL, AND WAS IT A PERSON THAT DID IT?
    //
    // The claim the safe-spot machine now stands or falls on: `proven` was retired on
    // 2026-08-28 because a wall the fleet identifies is trusted with lives, so a death ON one
    // should only ever be PVP. Surfaced rather than left in the JSON, because a falsifiable
    // claim nobody reads is not falsifiable.
    //
    // `wall_death_by_monster` is the one worth alerting on: it means the square was not a
    // wall, and the book needs to hear about it.
    at_a_safe_wall: pm.summary?.at_a_safe_wall ?? null,
    wall_death_by_monster: (() => {
      const w = pm.summary?.at_a_safe_wall;
      if (!w) return false;
      const people = (w.players_present ?? []).length > 0;
      return !people && (w.killed_by ?? []).length > 0;
    })(),
    during_keeper_outage: pm.during_keeper_outage ?? null,
    last_frame: last ? { room: last.room, num: last.num, col: last.col, row: last.row,
                         health: last.health, max: last.max, threats: last.threats ?? [],
                         dt: pm.at - last.at } : null,
    frames: frames.length,
    hits: (pm.hits || []).length,
    text,
  };
}

// ------------------------------------------------------------------ the treemap facets
//
// d3.treemap takes a hierarchy, so every facet is two levels: the thing being counted,
// then who it happened to. That second level is not decoration — "the border of the
// Badlands killed 35 characters" and "the border of the Badlands killed Zoot 35 times"
// are different problems and only the nesting tells them apart.

const bucket = (rows, keyOf, labelOf = keyOf) => {
  const top = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null) continue;
    const g = top.get(k) ?? { name: labelOf(r), value: 0, children: new Map(), meta: {} };
    g.value++;
    g.children.set(r.character, (g.children.get(r.character) || 0) + 1);
    top.set(k, g);
  }
  return [...top.entries()].map(([k, g]) => ({
    name: g.name, key: k, value: g.value,
    children: [...g.children.entries()].sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value })),
  })).sort((a, b) => b.value - a.value);
};

export function facets(rows) {
  // CAUSE splits on whether the killer was OBSERVED, at the top level, because mixing a
  // server announcement with a 51%-accurate guess produces a number that is neither.
  const observed = rows.filter(r => r.cause.observed);
  const guessed = rows.filter(r => !r.cause.observed && r.cause.killer);
  const unknown = rows.filter(r => !r.cause.killer).length;

  // PLACE is trusted-only, by construction. This is the facet the whole trust rule
  // exists for — an unplaced death contributes to the count and to nothing else.
  const placed = rows.filter(r => r.where.trusted && r.where.room);

  return {
    cause: {
      children: bucket(observed, r => r.cause.killer),
      total: observed.length,
      inferred: bucket(guessed, r => r.cause.killer),
      inferred_total: guessed.length,
      unknown,
      note: `${observed.length} of ${rows.length} deaths were announced by the server and name ` +
            `the killer outright. ${guessed.length} are a guess from what was standing nearby, ` +
            'which matches about half the time, and are kept separate for that reason' +
            (unknown ? `. ${unknown} have neither` : ''),
    },
    place: {
      children: bucket(placed, r => r.where.num ?? r.where.room, r => r.where.room),
      total: placed.length,
      unplaced: rows.length - placed.length,
      note: `${placed.length} of ${rows.length} deaths have a location backed by an observation ` +
            `within ${Math.round(TRUST_MS / 1000)}s of the killing blow. The other ` +
            `${rows.length - placed.length} are not shown anywhere on this map: the room in ` +
            'their file is the last place anybody looked, which is how inns end up in a list ' +
            'of places characters died',
    },
  };
}

// ------------------------------------------------------------------ the command line

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n, d = null) => {
    const i = process.argv.indexOf('--' + n);
    return i < 0 ? d : (process.argv[i + 1] ?? true);
  };
  const spec = String(arg('since', ''));
  const m = /^(\d+)\s*([hdm])$/.exec(spec);
  const sinceMs = m ? Number(m[1]) * ({ m: 60e3, h: 3600e3, d: 86400e3 })[m[2]] : null;

  // WHOSE DEATHS. This directory is keyed by character name and nothing else, so a
  // machine that has ever run a second fleet has that fleet's deaths in it for ever.
  // Scoped to the fleet the BROKER is holding — see m59-fleetscope.mjs for why that and
  // not the fleet named in a file. `--all-fleets` puts it back.
  const { fleetScope, partition, scopeLine } = await import('./m59-fleetscope.mjs');
  const scope = await fleetScope({ allFleets: process.argv.includes('--all-fleets') });

  // AND WHOSE TREE. The scope above picks a fleet out of a store; this picks the store. They
  // are different questions and only one of them used to be asked, so this tool answered
  // "0 deaths in that window" on 2026-09-10 for the same twelve hours in which prod died
  // forty-four times. The argument is above `substrateOf`.
  const stores = await resolvePostmortemStores({
    explicit: arg('postmortems', null),
    probe: !process.argv.includes('--no-probe'),
  });
  const store = stores[0];
  const { kept: rows, setAside } = partition(loadPostmortems({ sinceMs, dir: store.dir }), scope);

  const f = facets(rows);
  console.log(`${rows.length} deaths${sinceMs ? ' in that window' : ''}`);
  console.log(`  ${store.records} record(s) in ${store.dir} [${store.why}]`);
  for (const o of stores.slice(1)) {
    if (!o.records || (store.newest && o.newest && o.newest <= store.newest)) continue;
    console.log(`  ALSO ON THIS MACHINE: ${o.records} record(s), newer, in ${o.dir} [${o.why}]`);
  }
  console.log('  ' + scopeLine(scope, setAside) + '\n');
  console.log('WHAT KILLED THEM — announced by the server');
  for (const c of f.cause.children.slice(0, 12))
    console.log('  ' + String(c.value).padStart(4) + '  ' + c.name);
  console.log(`  (${f.cause.inferred_total} more are a guess from the crowd; ${f.cause.unknown} have nothing)\n`);
  console.log('WHERE THEY DIED — only where an observation places them');
  for (const c of f.place.children.slice(0, 12))
    console.log('  ' + String(c.value).padStart(4) + '  ' + c.name);
  console.log(`\n  ${f.place.unplaced} deaths are UNPLACED and deliberately absent from that list.`);
  console.log('  ' + f.place.note);
}
