#!/usr/bin/env node
// WHO ELSE IS IN THE WORLD, AND WHEN — every non-fleet player login and logoff, written down once.
//
//   node tools/m59-sightings.mjs                   # online now, then the last 24h of sessions
//   node tools/m59-sightings.mjs --online          # who is online now per the ledger, enemies first
//   node tools/m59-sightings.mjs --enemy           # enemy sessions only (war book, grudge, killer)
//   node tools/m59-sightings.mjs --player Morpheus # one player's spans: logon -> logoff, durations, last seen
//   node tools/m59-sightings.mjs --since 7d --json
//   node tools/m59-sightings.mjs --fleet prod      # which fleet's history (resolved like every tool)
//
// THE SERVER ALREADY TELLS US. A login is advertised to every logged-on user:
// `user.kod` LogOn sends `SystemUserLogonAdvertise` (system.kod:967), which loops
// `plUsers_logged_on` and sends each one `SomeoneLogon`; that sends BP_PLAYER_ADD (137) carrying
// the player's object id and `GetTrueName` (user.kod:792-800) -- the TRUE name, so an anonymity
// spell or a shadow form does not hide who it is. Logoff is the mirror: `SystemUserLogoffAdvertise`
// (system.kod:979) -> `SomeoneLogoff` -> BP_PLAYER_REMOVE (138) carrying the OBJECT ID ONLY
// (user.kod:824-843). `m59-client.mjs` raises them as `logged-on {id,name,flags}` and
// `logged-off {id,name}`, the name on a logoff being whatever that client's `playersOnline` held.
// One exception the server makes on purpose: a HIDDEN DM is advertised to admins only
// (user.kod:606-621, :724-740), so a hidden DM never appears here, and that is not a gap.
//
// THE PROBLEM IS NOT HEARING IT, IT IS HEARING IT TWENTY-FOUR TIMES. Every keeper process holds
// its own socket, so every one of them receives every advertisement, a few milliseconds to a few
// seconds apart (a keeper loop blocked in a route plan reads its socket late). The operator's
// requirement, 2026-10-04: each login or logoff appears EXACTLY ONCE in the ledger and once in
// the alerts file -- through keeper restarts, handoffs (old and new process both alive), and a
// few seconds of skew between processes.
//
// HOW EXACTLY-ONCE IS DONE: FIRST WRITER WINS, DECIDED UNDER ONE LOCK, BY SEQUENCE ALIGNMENT.
//
//   * Every observation is decided inside one critical section per fleet (`sightings.lock`,
//     O_EXCL create), which reads `sightings-state.json`, decides, appends, and writes the state
//     back. The decision is serialised, so "only the first writer records" is a fact rather than
//     a probability.
//   * THE IDEMPOTENCY KEY IS (normalised name, wire kind, position in that name's event stream),
//     NOT A TIME BUCKET. The server sends one name's events to every client in the SAME ORDER
//     (one TCP stream each, written by one interpreter in one loop). So each observer remembers,
//     per name, the sequence number of the recorded row its own last event matched (`matched`).
//     Its next event is a duplicate iff a recorded row of the SAME kind for the SAME name exists
//     AFTER that row and within DEDUPE_MS (30s) of this observer's clock; it is matched to the
//     EARLIEST such row and `matched` advances. Otherwise it is new: it is recorded and becomes
//     this observer's `matched`. (Earliest, not closest: "closest" pairs a keeper that is further
//     behind than a relog interval with the NEXT event's row -- the test caught it writing a
//     relog twice.)
//   * WHY NOT A TIME BUCKET: a bucket boundary splits one burst into two keys -- the event at
//     11:59:59.8 on one keeper and 12:00:00.3 on another are two "first writers". There is no
//     boundary here: the 30s is a tolerance around a recorded row, never a grid.
//   * WHY NOT "SAME KIND WITHIN 30s": a player relogging inside a second (logoff, logon) defeats
//     it for any keeper whose loop is a second late -- its logoff would be compared against a
//     recorded logon and look new. The stream position is what tells "the logoff I am late for"
//     from "a new logoff"; the clock only bounds the search.
//   * A process with no history for a name (just started, or the new half of a handoff) has no
//     `matched`. It takes the earliest same-kind row within 30s that is no older than its own
//     login list less LIST_LAG_SLACK_MS (10s) -- a row from before it was in the world is an event
//     it never heard. RESIDUAL CORNER, stated rather than hidden: a player who relogs twice inside
//     30s around the moment a keeper logs in can pair that keeper's first event with the wrong
//     row; every other keeper still records correctly, so it costs an event only if that keeper
//     is the sole one in the world, and a duplicate only if its login list was processed >10s late.
//   * NO ELECTED WRITER. A nominated observer is one restart away from a silently missing event
//     (the same argument as the save markers, docs/m59-evidence.md); here any live keeper records
//     and the rest are absorbed, so nothing is lost while at least one keeper is in the world.
//   * A LOCK THAT CANNOT BE TAKEN IN 50ms DEFERS, IT DOES NOT GUESS. The observation is queued in
//     memory and retried on the next tick; writing unlocked would be a duplicate, dropping it a
//     loss. A lock older than LOCK_STALE_MS whose writer pid is dead is broken.
//   * AND THE READER COLLAPSES ANYWAY, on the recorded order: two adjacent same-kind rows for one
//     name within 30s are one event. That should never fire; `--json` reports `collapsed` so a
//     writer bug surfaces as a number rather than as a double alert.
//
// WHAT IS RECORDED (substrate/history/<fleet>/sightings-YYYY-MM-DD.jsonl, schema m59-sightings/v1):
//   logon / logoff    a wire event, `at` = the first recording keeper's receipt time
//   present           in a full player list (BP_PLAYERS) but no open session: online at `at`, logon
//                     time unknown. Written at once when a watch begins after a gap; otherwise a
//                     list's disagreement waits RECONCILE_GUARD_MS (60s) and is dropped if a wire
//                     row for that name explains it (a peer keeper was merely behind), so `at` is
//                     the LIST's time and the row may be written up to ~90s later.
//   absent            had an open session, missing from a full list: logged off somewhere in
//                     `between`, exact time unknown. Same 60s guard.
//   watch_resumed     no keeper was watching from `gap_from` to `gap_to`. Every span crossing it is
//                     UNKNOWN, and the reader says so rather than inventing an end.
// Fleet characters (and menagerie hosts) are never recorded: `isFleetmate` from the keeper's own
// roster source. Hosts are ours for "do not shoot", and a relog is not a sighting.
//
// WHY A FILE OF ITS OWN AND NOT A KIND IN fleet-*.jsonl: the fleet ledger is keyed by FLEET
// CHARACTER (`character`), and every reader of it -- savelog, minimal, the boards -- treats each
// distinct `character` as one of ours. A stranger written there becomes a fleet character in the
// audit (the same failure the ledger's test guard exists for). Same directory, so it is per-fleet
// exactly as the ledger is (`ledgerDirFor`), and resolved by the same function.
//
// ENEMY ALERTS (substrate/history/<fleet>/enemy-alerts.log), one plain line per recorded row whose
// player is hostile (`hostileBasis`, m59-ally.mjs: war flag, war book, grudge book of any age, a
// PvP-death killer), written in the same critical section as the row, so exactly once:
//   2026-10-04T12:34:56Z ENEMY ONLINE Morpheus (Human Resistance; war_book) seen by Kermit
//   2026-10-04T13:02:10Z ENEMY OFFLINE Morpheus (Human Resistance; war_book) after 27m14s seen by Kermit
//   2026-10-04T14:00:00Z ENEMY PRESENT Morpheus (...) online when the watch began, logon time unknown
//   2026-10-04T14:00:00Z ENEMY GONE Morpheus (...) logged off between 13:10:00Z and 14:00:00Z
// `tail -F` it.

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const SCHEMA = 'm59-sightings/v1';
export const DEDUPE_MS = 30_000;          // how far apart two keepers' copies of one event may be
export const RECONCILE_GUARD_MS = 60_000; // a full list never overrides a wire event this recent
export const HEARTBEAT_GAP_MS = 120_000;  // no observer heartbeat this long = nobody was watching
export const TICK_MS = 30_000;
export const RECENT_KEEP_MS = 10 * 60_000;
export const LOCK_WAIT_MS = 50;      // then defer to the next tick: a keeper loop is not ours to block
export const LOCK_STALE_MS = 5_000;
export const LIST_LAG_SLACK_MS = 10_000; // how late a keeper may process its own login list

const WIRE = new Set(['logon', 'logoff']);
export const fold = n => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const iso = t => new Date(t).toISOString();
const isoS = t => iso(t).replace(/\.\d{3}Z$/, 'Z');

export const pathsFor = dir => ({
  dir,
  state: join(dir, 'sightings-state.json'),
  lock: join(dir, 'sightings.lock'),
  alerts: join(dir, 'enemy-alerts.log'),
  day: t => join(dir, 'sightings-' + iso(t).slice(0, 10) + '.jsonl'),
});

// ------------------------------------------------------------------ the lock

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** Take the fleet's sightings lock, or return null inside `waitMs`. Never throws for contention. */
export function takeLock(p, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(p.lock, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {}
      return () => { try { closeSync(fd); } catch {} try { unlinkSync(p.lock); } catch {} };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    // ABANDONED? A holder keeps it for a few milliseconds. Older than staleMs AND its pid dead
    // (or unreadable and much older) is a crash, not a writer.
    try {
      const age = Date.now() - statSync(p.lock).mtimeMs;
      if (age > staleMs) {
        let pid = null; try { pid = JSON.parse(readFileSync(p.lock, 'utf8')).pid; } catch {}
        if ((pid != null && !pidAlive(pid)) || age > staleMs * 6) {
          const aside = p.lock + '.stale-' + process.pid + '-' + Date.now();
          try { renameSync(p.lock, aside); unlinkSync(aside); } catch {}
          continue;
        }
      }
    } catch { /* it went away between the open and the stat: try again */ }
    if (Date.now() >= deadline) return null;
    Atomics.wait(SLEEP, 0, 0, 3);
  }
}

// ------------------------------------------------------------------ state

export function emptyState() {
  // `epoch` names this state file's seq space: an observer's remembered position is meaningless
  // against a state that was deleted and restarted from 0, and is dropped rather than compared.
  return { v: 1, epoch: Date.now().toString(36) + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8),
           seq: 0, heartbeat: null, heartbeat_by: null, recent: [], open: {}, pending: {}, stats: { absorbed: 0 } };
}

export function readState(p) {
  try {
    const s = JSON.parse(readFileSync(p.state, 'utf8'));
    if (s && s.v === 1) return { ...emptyState(), ...s, stats: { ...emptyState().stats, ...(s.stats ?? {}) } };
  } catch { /* first run, or a torn write: the ledger is the record, this is only the cursor */ }
  return emptyState();
}

function writeState(p, s) {
  const tmp = p.state + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(s));
  try { renameSync(tmp, p.state); }
  catch { writeFileSync(p.state, JSON.stringify(s)); try { unlinkSync(tmp); } catch {} }
}

/**
 * Which recorded row (if any) is this observer's copy of the wire event `kind` for `key`.
 *
 * The EARLIEST same-kind row after `after` (the row this observer's previous event for the name
 * matched) and within `windowMs` of `at`. Earliest, not closest: an observer hears one name's
 * events in the server's order, so the next unmatched same-kind row IS the event it is hearing,
 * and a later one is an event it has not heard yet. "Closest" picks the later row whenever this
 * observer is further behind than the player's relog interval -- measured in the test, a keeper 5s
 * late on a 400ms relog wrote the logoff and logon a second time.
 *
 * With no history for the name, `after` is null and `notBefore` (the observer's clock when its
 * login list arrived, less LIST_LAG_SLACK_MS) keeps it from matching a row for an event that
 * happened before it was in the world to hear it.
 */
export function matchRecorded(recent, { key, kind, at, after = null, notBefore = null, windowMs = DEDUPE_MS }) {
  let best = null;
  for (const r of recent) {
    if (r.n !== key || r.k !== kind) continue;
    if (after != null && r.s <= after) continue;
    if (after == null && notBefore != null && r.at < notBefore) continue;
    if (Math.abs(r.at - at) > windowMs) continue;
    if (!best || r.s < best.s) best = r;
  }
  return best;
}

// ------------------------------------------------------------------ classification

/**
 * Who this player is to the fleet: `hostileBasis` (m59-ally.mjs) decides enemy or not -- war flag,
 * war book, grudge book of any age, a PvP-death killer, in that order -- so a sighting and a
 * refused buff can never disagree about who the enemy is. `guild` is the war book's last
 * observation whatever the guild; `pk` is the server's name colour (PF_* is an ENUM: red, orange,
 * dm...), which is information, not hostility.
 * Built from injected functions so the reader never has to load the books.
 */
export function makeClassifier({ hostileBasis, membership = () => null, playerClassName = () => null }) {
  return (name, flags) => {
    const h = hostileBasis({ name, flags: flags ?? 0 });
    let guild = null; try { guild = membership(name)?.guild ?? null; } catch {}
    return { class: h?.basis ?? 'stranger', enemy: !!h, why: h?.why ?? null, guild,
             pk: Number.isFinite(flags) ? playerClassName(flags) : null };
  };
}

/** The live books, loaded lazily. */
export async function defaultClassifier() {
  const { hostileBasis } = await import('./m59-ally.mjs');
  const { membership } = await import('./m59-war.mjs');
  const { playerClassName } = await import('./m59-parse.mjs');
  return makeClassifier({ hostileBasis, membership, playerClassName });
}

function alertLine(row) {
  const who = `${row.name} (${[row.guild, row.class].filter(Boolean).join('; ')})`;
  const by = row.observed_by ? ` seen by ${row.observed_by}` : '';
  switch (row.kind) {
    case 'logon': return `${isoS(row.at)} ENEMY ONLINE ${who}${by}`;
    case 'logoff': return `${isoS(row.at)} ENEMY OFFLINE ${who}` +
      (Number.isFinite(row.session_ms) ? ` after ${fmtDur(row.session_ms)}` : '') + by;
    case 'present': return `${isoS(row.at)} ENEMY PRESENT ${who} online when the list was read, logon time unknown${by}`;
    case 'absent': return `${isoS(row.at)} ENEMY GONE ${who} logged off between ` +
      `${isoS(row.between[0])} and ${isoS(row.between[1])}${by}`;
    default: return null;
  }
}

// ------------------------------------------------------------------ the observer (one per keeper)

/**
 * One keeper's observer. Every keeper of a fleet makes one; they share `dir` and the lock is what
 * makes them one writer.
 *
 * @param {object} o
 *   dir           the fleet's history directory (ledgerDirFor)
 *   agent         this keeper's agent id, for `observed_by_agent`
 *   isFleetmate   name -> bool (the keeper's roster source; includes hosts and itself)
 *   classify      (name, flags) -> {class, enemy, why, guild, pk}  (sync)
 *   refresh       () => void : ask the server for a full list (BP_SEND_PLAYERS) -- optional
 *   now           clock, injectable
 */
export function createSightingsObserver({ dir, agent = null, character = null, isFleetmate = () => false, classify = null,
  refresh = null, now = () => Date.now(), log = () => {}, lock = {} } = {}) {
  const p = pathsFor(dir);
  const matched = new Map();       // fold(name) -> {epoch, s}: the recorded wire row my last event was
  const ready = new WeakMap();     // client -> my clock when it delivered a full list (playersOnline is real)
  const queue = [];                // observations deferred by a busy lock, oldest first
  const stats = { recorded: 0, absorbed: 0, excluded: 0, unnamed: 0, deferred: 0, held: 0, alerts: 0, errors: 0, last_error: null };
  let lastHeartbeat = 0, wantList = false;
  const cls = (name, flags) => {
    try { return classify ? classify(name, flags) : { class: 'stranger', enemy: false, guild: null, pk: null }; }
    catch (e) { return { class: 'unknown', enemy: false, why: 'classifier failed: ' + e.message, guild: null, pk: null }; }
  };
  const mate = n => { try { return !!isFleetmate(n); } catch { return false; } };

  // Returns false (lock busy), 'hold' (the job asked to wait for the ledger to catch up) or true.
  function transact(entry) {
    mkdirSync(dir, { recursive: true });
    const release = takeLock(p, lock);
    if (!release) return false;
    try {
      const s = readState(p);
      const rows = [], alerts = [];
      const put = row => {
        row.seq = ++s.seq;
        rows.push({ schema: SCHEMA, ...row, epoch: s.epoch, iso: iso(row.at) });
        if (row.enemy) { const l = alertLine(row); if (l) alerts.push(l); }
        s.recent.push({ s: row.seq, k: row.kind, n: fold(row.name), at: row.at });
      };
      const out = entry.job(s, put, { force: now() - entry.since > DEDUPE_MS });
      commitPending(s, put, now());
      const cut = now() - RECENT_KEEP_MS;
      s.recent = s.recent.filter(r => r.at >= cut);
      const byDay = new Map();
      for (const r of rows) { const f = p.day(r.at); byDay.set(f, (byDay.get(f) ?? '') + JSON.stringify(r) + '\n'); }
      for (const [f, text] of byDay) appendFileSync(f, text);
      if (alerts.length) appendFileSync(p.alerts, alerts.join('\n') + '\n');
      writeState(p, s);
      stats.recorded += rows.length; stats.alerts += alerts.length;
      return out === 'hold' ? 'hold' : true;
    } finally { release(); }
  }

  function run(job) {
    const entry = { job, since: now() };
    try {
      // ORDER IS THE KEY: this observer's events must reach the ledger in the order it heard them,
      // because its `matched` cursor walks the name's stream. So nothing overtakes a waiting job.
      if (queue.length) { queue.push(entry); stats.deferred++; drain(); return false; }
      const r = transact(entry);
      if (r === true) {
        if (wantList) { wantList = false; if (refresh) try { refresh(); } catch {} }
        return true;
      }
      if (r === 'hold') stats.held++; else stats.deferred++;
      queue.push(entry);
      if (queue.length > 500) queue.splice(0, queue.length - 500);
      return false;
    } catch (e) { stats.errors++; stats.last_error = e.message; log('sightings: ' + e.message); return false; }
  }
  function drain() {
    while (queue.length) {
      try { if (transact(queue[0]) !== true) return; } catch (e) { stats.errors++; stats.last_error = e.message; }
      queue.shift();
    }
  }

  // A heartbeat older than the gap means nobody was watching: say so before anything else.
  function gapCheck(s, put, at, observer) {
    const t = now();
    if (s.heartbeat == null || t - s.heartbeat > HEARTBEAT_GAP_MS) {
      put({ kind: 'watch_resumed', at: t, name: null, gap_from: s.heartbeat ?? null, gap_to: t,
            observed_by: observer, agent, open_at_gap: Object.values(s.open).map(o => o.name) });
      wantList = true;   // the sessions open across the gap need a full list to be settled
      s.heartbeat = t; s.heartbeat_by = agent;
      return true;
    }
    s.heartbeat = Math.max(s.heartbeat, t); s.heartbeat_by = agent;
    return false;
  }

  function wire(kind, ev, c) {
    const observer = c?.me?.name ?? character;
    let at = Number.isFinite(ev.at) ? ev.at : now(), heardAt = null;
    let name = ev.name ?? null;
    const flags = Number.isFinite(ev.flags) ? ev.flags : null;
    const watching = !!c && ready.has(c);
    const readyAt = c ? ready.get(c) : undefined;
    return (s, put, { force = false } = {}) => {
      // A logoff names only an object id; this client may not have had the name (it logged in
      // after, or a save renumbered the ids). The open session remembers whose id it was.
      if (!name && ev.id != null) name = Object.values(s.open).find(o => o.id === ev.id)?.name ?? null;
      if (!name) { stats.unnamed++; return; }
      if (mate(name)) { stats.excluded++; return; }
      const key = fold(name);
      if (watching) gapCheck(s, put, at, observer);
      const mine = matched.get(key);
      const dup = matchRecorded(s.recent, { key, kind, at, after: mine?.epoch === s.epoch ? mine.s : null,
        notBefore: Number.isFinite(readyAt) ? readyAt - LIST_LAG_SLACK_MS : null });
      if (dup) { matched.set(key, { epoch: s.epoch, s: dup.s }); stats.absorbed++; s.stats.absorbed = (s.stats.absorbed ?? 0) + 1; return; }
      const open = s.open[key];
      // NOT YET. A logoff for somebody the ledger has offline, or a logon for somebody it has
      // online, means a peer that heard the event BEFORE this one has not written it yet -- a
      // keeper that logged in a moment ago can be seconds ahead of one whose loop is late.
      // Recording now would put the pair in the wrong order, and the late peer would then fail
      // to find its own copy after its own row and write it again (measured: 15s delays, a
      // handoff, one duplicate logoff in forty seeds). So it waits, in order, until the ledger
      // agrees or DEDUPE_MS passes; then it is recorded anyway, because an event nobody else
      // heard (a missed logon) must still not be lost.
      // (A `present` still pending is not agreement: a list that disagrees is itself the lag symptom.)
      const consistent = kind === 'logon' ? !open : !!open;
      if (!consistent && !force) return 'hold';
      // A per-name timeline that never runs backwards: rows carry the first recorder's clock.
      const lastAt = s.recent.filter(r => r.n === key && WIRE.has(r.k)).reduce((m, r) => Math.max(m, r.at), -Infinity);
      if (Number.isFinite(lastAt) && at < lastAt) { heardAt = at; at = lastAt; }
      const c0 = kind === 'logon' ? cls(name, flags) : (open ?? cls(name, flags));
      const row = { kind, at, name, id: ev.id ?? null, class: c0.class, enemy: !!c0.enemy, guild: c0.guild ?? null,
                    pk: kind === 'logon' ? (c0.pk ?? null) : (open?.pk ?? null), observed_by: observer, agent };
      if (c0.why) row.why = c0.why;
      if (heardAt != null) row.heard_at = heardAt;
      if (!consistent) row.inconsistent = kind === 'logon' ? 'already open: a logoff was missed' : 'not open: a logon was missed';
      if (kind === 'logoff' && open) {
        row.since = open.since; row.since_known = open.since_known;
        if (open.since_known && Number.isFinite(open.since)) row.session_ms = at - open.since;
      }
      put(row);
      if (s.pending) delete s.pending[key];
      matched.set(key, { epoch: s.epoch, s: row.seq });
      if (kind === 'logon') s.open[key] = { name, id: ev.id ?? null, since: at, since_known: true, last_confirmed: at,
        class: row.class, enemy: row.enemy, guild: row.guild, pk: row.pk };
      else delete s.open[key];
    };
  }

  // A FULL LIST (BP_PLAYERS): at login, on a `who`, after a save. It begins a watch and corrects
  // what the wire stream missed -- but a disagreement is only a CANDIDATE for RECONCILE_GUARD_MS.
  // A keeper that has just logged in reads a list that is seconds AHEAD of a peer whose loop is
  // late: the list already lacks a player whose logoff the peer has not processed yet. Writing
  // `absent` on the spot and then the peer's `logoff` would be one departure written twice. So a
  // disagreement waits in `pending`, any wire row for that name inside the guard cancels it, and
  // only an unexplained one is committed -- with the LIST's time, not the commit's.
  // Right after a watch gap nobody can be behind (nobody was logged in), so it commits at once.
  function list(ev, c) {
    const observer = c?.me?.name ?? character;
    const players = (ev.players ?? []).filter(x => x?.name);
    return (s, put) => {
      const t = now();
      const gap = gapCheck(s, put, t, observer);
      wantList = false;   // this IS the list
      s.pending ??= {};
      const seen = new Set();
      for (const pl of players) {
        if (mate(pl.name)) continue;
        const key = fold(pl.name);
        seen.add(key);
        const open = s.open[key];
        if (open) {
          open.id = pl.id ?? open.id; open.last_confirmed = t;
          if (s.pending[key]?.kind === 'absent') delete s.pending[key];
          continue;
        }
        if (!s.pending[key]) s.pending[key] = { kind: 'present', at: t, name: pl.name, id: pl.id ?? null,
          flags: Number.isFinite(pl.flags) ? pl.flags : null, observer, why_present: gap ? 'watch_resumed' : 'reconcile' };
      }
      // A list that does not contain the reader itself is not a list we trust to say who LEFT.
      const self = fold(c?.me?.name ?? character);
      if (!self || players.some(x => fold(x.name) === self)) {
        for (const [key, pend] of Object.entries(s.pending))
          if (pend.kind === 'present' && !seen.has(key)) delete s.pending[key];   // came and went unconfirmed
        for (const [key, open] of Object.entries(s.open)) {
          if (seen.has(key) || s.pending[key]) continue;
          // Last moment he was known to be on: the last list that had him, else his logon. Across
          // a watch gap that is before the gap, which is exactly the uncertainty the row carries.
          s.pending[key] = { kind: 'absent', at: t, name: open.name, id: open.id ?? null, observer,
                             from: open.last_confirmed ?? open.since };
        }
      }
      if (gap) commitPending(s, put, t, { force: true });
    };
  }

  function commitPending(s, put, t, { force = false } = {}) {
    for (const [key, p0] of Object.entries(s.pending ?? {})) {
      if (!force && t - p0.at < RECONCILE_GUARD_MS) continue;
      delete s.pending[key];
      // A wire row for him around the list's time explains the disagreement: a peer was behind,
      // or he relogged across the list. (A peer's row can carry an `at` before the list's by its
      // lag and skew, hence the DEDUPE_MS reach back.)
      if (s.recent.some(r => r.n === key && WIRE.has(r.k) && r.at >= p0.at - DEDUPE_MS)) continue;
      if (p0.kind === 'present') {
        if (s.open[key]) continue;
        const c0 = cls(p0.name, p0.flags);
        const row = { kind: 'present', at: p0.at, name: p0.name, id: p0.id, class: c0.class, enemy: !!c0.enemy,
                      guild: c0.guild ?? null, pk: c0.pk ?? null, why_present: p0.why_present,
                      observed_by: p0.observer, agent };
        put(row);
        s.open[key] = { name: p0.name, id: p0.id, since: p0.at, since_known: false, last_confirmed: p0.at,
                        class: row.class, enemy: row.enemy, guild: row.guild, pk: row.pk };
      } else {
        const open = s.open[key];
        if (!open) continue;
        put({ kind: 'absent', at: p0.at, name: open.name, id: open.id ?? null, class: open.class, enemy: !!open.enemy,
              guild: open.guild ?? null, pk: open.pk ?? null, between: [Math.min(p0.from ?? p0.at, p0.at), p0.at],
              since: open.since, since_known: open.since_known, observed_by: p0.observer, agent });
        delete s.open[key];
      }
    }
  }

  const api = {
    /** Feed every client event here; ignores what is not ours. */
    event(ev, c) {
      if (!ev) return;
      try {
        if (ev.kind === 'logged-on') { drain(); run(wire('logon', ev, c)); }
        else if (ev.kind === 'logged-off') { drain(); run(wire('logoff', ev, c)); }
        else if (ev.kind === 'who') { if (c && !ready.has(c)) ready.set(c, now()); drain(); run(list(ev, c)); }
        // A SAVE RENUMBERS OBJECT IDS, and a logoff carries nothing but an id. Re-read the list
        // after one, jittered so twenty-four keepers do not ask in the same millisecond.
        else if (ev.kind === 'server-save' && ev.phase === 'end' && refresh) {
          const t = setTimeout(() => { try { refresh(); } catch {} }, Math.floor(Math.random() * 10_000));
          t.unref?.();
        }
      } catch (e) { stats.errors++; stats.last_error = e.message; }
    },
    /** Every TICK_MS while in the world: heartbeat, retry deferred work, notice a gap. */
    tick(c, { watching = true } = {}) {
      try {
        drain();
        if (queue.length) return;            // still waiting: the heartbeat goes in behind it later
        if (!watching || !c || !ready.has(c)) return;
        if (now() - lastHeartbeat < TICK_MS / 2) return;
        // A gap noticed by a heartbeat has no list to reconcile with yet: gapCheck asks for one.
        if (run((s, put) => { gapCheck(s, put, now(), c?.me?.name ?? character); })) lastHeartbeat = now();
      } catch (e) { stats.errors++; stats.last_error = e.message; }
    },
    status: () => ({ ...stats, queued: queue.length, dir }),
    _matched: matched,
  };
  return api;
}

// ------------------------------------------------------------------ the reader

export function readRows(dir) {
  let files = [];
  try { files = readdirSync(dir).filter(f => /^sightings-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); }
  catch { return []; }
  const rows = [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    for (const l of lines) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.schema === SCHEMA) rows.push(r); } catch { /* a torn last line */ }
    }
  }
  // THE RECORDED ORDER, NOT THE CLOCK ORDER. `at` is whichever keeper recorded the row first, on
  // its own clock and its own lag, so a fast relog's logoff can carry a LATER `at` than the logon
  // that followed it -- sorted by time, the pair reads logon, logon and the collapse eats one. The
  // seq the writer assigned under its lock is the server's order for each name. A state reset
  // starts a new `epoch` (and seq at 0), so epochs are ordered by their first row's time.
  const first = new Map();
  for (const r of rows) { const e = r.epoch ?? ''; if (!first.has(e) || r.at < first.get(e)) first.set(e, r.at); }
  return rows.sort((a, b) => (first.get(a.epoch ?? '') - first.get(b.epoch ?? '')) ||
    ((a.seq ?? 0) - (b.seq ?? 0)) || (a.at - b.at));
}

/** Drop a second copy of one wire event: adjacent same-kind rows for a name within DEDUPE_MS. */
export function collapse(rows) {
  const last = new Map();
  const out = [];
  let collapsed = 0;
  for (const r of rows) {
    if (!r.name || !(WIRE.has(r.kind) || r.kind === 'present' || r.kind === 'absent')) { out.push(r); continue; }
    const key = fold(r.name);
    const prev = last.get(key);
    if (prev && WIRE.has(r.kind) && prev.kind === r.kind && Math.abs(r.at - prev.at) <= DEDUPE_MS) { collapsed++; continue; }
    last.set(key, r);
    out.push(r);
  }
  return { rows: out, collapsed };
}

/**
 * Pair rows into sessions. A session is {name, start, start_known, end, end_known, end_between,
 * open, gaps, class, enemy, guild}. Nothing is invented: an end that no row states is null, with
 * the bounds that ARE known.
 */
export function sessions(rows) {
  const cur = new Map(), out = [], lastSeen = new Map();
  const close = (key, patch) => { const s = cur.get(key); if (!s) return; Object.assign(s, patch, { open: false }); cur.delete(key); };
  for (const r of rows) {
    if (r.kind === 'watch_resumed') {
      for (const s of cur.values()) s.gaps.push([r.gap_from ?? null, r.gap_to ?? r.at]);
      continue;
    }
    if (!r.name) continue;
    const key = fold(r.name);
    lastSeen.set(key, { at: r.at, kind: r.kind, name: r.name });
    const meta = { class: r.class ?? null, enemy: !!r.enemy, guild: r.guild ?? null };
    const make = (start, known) => {
      const s = { name: r.name, start, start_known: known, end: null, end_known: false, end_between: null,
                  open: true, gaps: [], ...meta };
      out.push(s); cur.set(key, s); return s;
    };
    if (r.kind === 'logon') {
      // A second logon with no logoff between: the logoff was missed (renumbered id, a crash).
      if (cur.has(key)) close(key, { end: null, end_known: false, end_between: [cur.get(key).start ?? null, r.at],
                                     note: 'next logon came with no logoff recorded' });
      make(r.at, true);
    } else if (r.kind === 'present') {
      const s = cur.get(key);
      if (s) { s.confirmed_at = r.at; Object.assign(s, meta); }
      else { const n = make(null, false); n.online_before = r.at; n.note = 'already online when first listed'; }
    } else if (r.kind === 'logoff') {
      const s = cur.get(key);
      if (s) close(key, { end: r.at, end_known: true });
      else { const n = make(null, false); n.note = 'logoff with no logon recorded'; close(key, { end: r.at, end_known: true }); }
    } else if (r.kind === 'absent') {
      if (cur.has(key)) close(key, { end: null, end_known: false, end_between: r.between ?? null,
                                     note: 'gone from a full list; logoff time unknown' });
    }
  }
  for (const s of out) {
    s.duration_ms = s.start_known && s.end_known ? s.end - s.start : null;
    // What IS known: a lower bound from the earliest moment we know he was on.
    const from = s.start_known ? s.start : s.online_before ?? null;
    const to = s.end_known ? s.end : s.end_between?.[0] ?? null;
    s.at_least_ms = s.duration_ms == null && from != null && to != null && to >= from ? to - from : null;
  }
  return { sessions: out, lastSeen };
}

export function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}

const parseSince = v => {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]];
};

/** The whole report, as data. `now` and `dir` injectable for the tests. */
export function report(dir, { now = Date.now(), sinceMs = 24 * 36e5, player = null, enemyOnly = false } = {}) {
  const p = pathsFor(dir);
  const raw = readRows(dir);
  const { rows, collapsed } = collapse(raw);
  const { sessions: all, lastSeen } = sessions(rows);
  const state = existsSync(p.state) ? readState(p) : null;
  const hb = state?.heartbeat ?? null;
  const watching = hb != null && now - hb <= HEARTBEAT_GAP_MS;
  const enemyFirst = (a, b) => (b.enemy - a.enemy) || String(a.name).localeCompare(String(b.name));
  const online = all.filter(s => s.open).sort(enemyFirst).map(s => ({
    ...s, online_for_ms: s.start_known ? now - s.start : null,
    online_at_least_ms: !s.start_known && s.online_before != null ? now - s.online_before : null,
  }));
  let list = all.filter(s => s.open || (s.end ?? s.end_between?.[1] ?? 0) >= now - sinceMs);
  if (enemyOnly) list = list.filter(s => s.enemy);
  if (player) list = all.filter(s => fold(s.name) === fold(player));
  const gaps = rows.filter(r => r.kind === 'watch_resumed' && (r.gap_to ?? r.at) >= now - sinceMs)
    .map(r => ({ from: r.gap_from ?? null, to: r.gap_to ?? r.at }));
  return {
    dir, now, watching, heartbeat: hb, heartbeat_age_ms: hb == null ? null : now - hb,
    rows: raw.length, collapsed,
    online: enemyOnly ? online.filter(s => s.enemy) : online,
    sessions: list,
    gaps,
    ...(player ? { player, last_seen: lastSeen.get(fold(player)) ?? null } : {}),
  };
}

function render(r, { mode }) {
  const out = [];
  const tag = s => (s.enemy ? 'ENEMY ' : '      ') + s.name + (s.guild ? ` <${s.guild}>` : '') + (s.enemy ? ` [${s.class}]` : '');
  const hhmm = t => t == null ? '?' : isoS(t).replace('T', ' ');
  if (!r.watching)
    out.push(r.heartbeat == null ? 'NO KEEPER HAS EVER WATCHED this fleet\'s sightings; nothing below is current.'
      : `NO KEEPER IS WATCHING NOW (last heartbeat ${fmtDur(r.heartbeat_age_ms)} ago, ${hhmm(r.heartbeat)}); ` +
        '"online" means online as of then.');
  if (mode === 'online' || mode === 'all') {
    out.push(`online now (${r.online.length}):`);
    for (const s of r.online)
      out.push(`  ${tag(s)}  ` + (s.start_known ? `since ${hhmm(s.start)} (${fmtDur(s.online_for_ms)})`
        : `since before ${hhmm(s.online_before)} (at least ${fmtDur(s.online_at_least_ms)})`) +
        (s.gaps.length ? `  [watch gap since; may have relogged]` : ''));
  }
  if (mode === 'sessions' || mode === 'all' || mode === 'player') {
    out.push(mode === 'player' ? `sessions for ${r.player}:` : 'sessions:');
    for (const s of r.sessions) {
      const a = s.start_known ? hhmm(s.start) : s.online_before != null ? `before ${hhmm(s.online_before)}` : 'unknown';
      const b = s.open ? 'online' : s.end_known ? hhmm(s.end)
        : s.end_between ? `between ${hhmm(s.end_between[0])} and ${hhmm(s.end_between[1])}` : 'unknown';
      const d = s.duration_ms != null ? fmtDur(s.duration_ms) : s.at_least_ms != null ? `>= ${fmtDur(s.at_least_ms)}` : '?';
      out.push(`  ${tag(s)}  ${a} -> ${b}  (${d})` + (s.gaps.length ? `  [spans ${s.gaps.length} watch gap(s)]` : '') +
        (s.note ? `  -- ${s.note}` : ''));
    }
    if (mode === 'player') out.push(r.last_seen ? `last seen ${hhmm(r.last_seen.at)} (${r.last_seen.kind})` : 'never seen');
  }
  if (r.gaps.length) {
    out.push('watch gaps (nobody was logged in to hear; spans across them are unknown):');
    for (const g of r.gaps) out.push(`  ${hhmm(g.from)} -> ${hhmm(g.to)}`);
  }
  if (r.collapsed) out.push(`note: ${r.collapsed} duplicate row(s) collapsed by the reader -- the writer should have absorbed them`);
  return out.join('\n');
}

// ------------------------------------------------------------------ CLI
if (/m59-sightings\.mjs$/.test(process.argv[1] ?? '')) {
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tools/m59-sightings.mjs [--fleet <name>] [--dir <path>] ' +
                '[--online | --enemy | --player <name>] [--since 24h] [--json]');
    process.exit(0);
  }
  let dir = val('--dir');
  if (!dir) { const { fleetName, ledgerDirFor } = await import('./m59-fleetpath.mjs'); dir = ledgerDirFor(fleetName(argv)); }
  const sinceMs = val('--since') ? parseSince(val('--since')) : 24 * 36e5;
  if (sinceMs == null) { console.error('--since wants e.g. 30m, 24h, 7d'); process.exit(2); }
  const player = val('--player');
  const enemyOnly = argv.includes('--enemy');
  const r = report(dir, { sinceMs, player, enemyOnly });
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else console.log(render(r, { mode: player ? 'player' : argv.includes('--online') ? 'online' : enemyOnly ? 'all' : 'all' }));
}
