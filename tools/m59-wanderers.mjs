// WHERE IS THE WANDERER: HIS ROOMS, WHAT THE FLEET HAS SEEN, AND WHO GOES WHERE TO FIND HIM.
//
// PUBLIC. The mechanism is `m59-research/reports/wandering-npcs.md` (pinned to Meridian59
// 1fb1f514), read from wanderer.kod:
//
//   * Five NPCs wander: Parrin Aragone, Maleval, Miriana, Tendrath, Izzio. Each has a FIXED list of
//     4-5 rooms and, every 30-90 min of real time (uniform), jumps to a uniformly random OTHER room
//     on it. No time of day, no rotation, no shared clock -- the wall clock says nothing.
//   * A PLAYER IN HIS ROOM HOLDS HIM. At each tick with a User present he stays and a counter goes
//     up; on the 6th tick he moves anyway (wanderer.kod:56-97). So one body parked with him keeps
//     him 3-9 h, and a body parked in EVERY room of his list means wherever he goes, somebody is
//     already standing there. That is the whole strategy this module serves.
//
// WHAT IS HERE, and what is not:
//
//   * WANDERERS -- the lists, as data (kept in m59-worldbook.mjs so a keeper can know them too).
//   * WHERE HE IS -- the fleet's WORLD BOOK (m59-worldbook.mjs, history/<fleet>/world-book.json).
//     Every keeper writes the NPCs in the room it stands in, every few seconds, so a wanderer that
//     walks past ANY fleet character is on the record; `recordView` adds a script's own `look` to
//     the same book, and `whereIs` / `searchOrder` read it.
//   * assignPosts -- "pull the closest N and put one in each room": closest-first by exit hops
//     over the compendium room graph; with fewer bodies than rooms, the rest of the list is
//     split into short sweep routes.
//   * watchSteps -- the fleetscript steps for one body: walk its route, look, record, and either
//     stop when he is found (`find`) or stay on post and hold him (`post`) until a deadline.
//
// Every walk here goes through the fleetscript `walk` step, so the health floor, the trap check
// and the p90 budgets apply; a run-time destination carries `candidates` naming every room it
// could choose (see DYNAMIC_FIELDS in m59-fleetscript.mjs).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, verify } from './m59-fleetscript.mjs';
import { ledgerDirFor, fleetName } from './m59-fleetpath.mjs';
import { WANDERERS, fold, applyRoom, updateBook, readBook, npcInfo, FRESH_MS } from './m59-worldbook.mjs';

export { WANDERERS };
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALIASES = Object.freeze({ perrin: 'parrin', 'parrin aragone': 'parrin', minstrel: 'parrin',
  darkwizard: 'maleval', heretic: 'miriana', hunterghost: 'tendrath' });

/** "Perrin", "parrin aragone", "DarkWizard" -> the WANDERERS key, or throw naming the known ones. */
export function wandererKey(name) {
  const k = String(name ?? '').trim().toLowerCase();
  const key = WANDERERS[k] ? k : ALIASES[k];
  if (!key) throw new Error(`unknown wanderer "${name}" -- known: ${Object.keys(WANDERERS).join(', ')}`);
  return key;
}

// wanderer.kod:18-19 -- the tick is random(1800000, 5400000) ms; the 6th tick with a player
// present moves him regardless.
export const TICK_MIN_MS = 30 * 60_000;
export const TICK_MAX_MS = 90 * 60_000;
export const HOLD_TICKS = 6;

// ---------------------------------------------------------------- where he is
//
// A SIGHTING IS A FACT ABOUT A MOMENT. He can leave the instant after, so `whereIs` answers
// `fresh` only for a sighting younger than `freshMs`, which any keeper standing with him renews
// about once a minute. Anything older is a rumour: the report's floor is "an arrival you SAW
// guarantees 30 minutes", and a sighting is not an arrival.

const bookDir = dir => dir ?? ledgerDirFor(fleetName());
const roomOf = v => Number(v?.room?.num ?? v?.room ?? NaN);

/** Which wanderers a `look` shows, by key. Matched on the displayed name, never on a player. */
export function wanderersIn(view) {
  const names = (view?.objects ?? []).filter(o => !o.is_player).map(o => fold(o.name));
  return Object.entries(WANDERERS).filter(([, w]) => names.includes(fold(w.npc))).map(([k]) => k);
}

/**
 * NOTE WHAT A LOOK SHOWS, IN THE WORLD BOOK. Every NPC in the view is recorded as seen here; an
 * NPC last recorded in this room and not in the view is recorded as gone; a wanderer whose list
 * holds this room is recorded as absent from it. Returns the wanderer keys seen. The lock is
 * waited for longer than a keeper waits (a script can afford half a second; a keeper tick cannot).
 */
export function recordView(view, agent, { now = Date.now(), dir = null } = {}) {
  const room = roomOf(view);
  if (!Number.isFinite(room)) return [];
  const objects = (view?.objects ?? []).map(o => ({ name: o.name, can: o.can ?? [], is_player: !!o.is_player, row: o.row, col: o.col }));
  updateBook(bookDir(dir), w => applyRoom(w, { agent, room, room_name: view?.room?.name ?? null, objects, now }), { waitMs: 500 });
  return wanderersIn(view);
}

/**
 * Where he is, as far as the fleet knows. `fresh` = seen within `freshMs` and not seen gone
 * since. `rumour` = the last room anyone saw him in, for a searcher to try first.
 */
export function whereIs(key, { now = Date.now(), freshMs = FRESH_MS, dir = null } = {}) {
  const info = npcInfo(readBook(bookDir(dir)), key, { now, freshMs });
  const r = info?._raw;
  if (!r?.room || r.at == null) return { fresh: false, room: null, rumour: null, absent: r?.absent ?? {} };
  const gone = r.left != null;
  return { fresh: !gone && now - r.at <= freshMs, room: gone ? null : r.room, rumour: gone ? null : r.room,
           age_ms: now - r.at, by: info.by, absent: r.absent };
}

/** His rooms, best first for a searcher: the rumour, then the rooms nobody has seen empty lately. */
export function searchOrder(key, { now = Date.now(), from = null, dir = null } = {}) {
  const w = WANDERERS[key];
  const at = whereIs(key, { now, dir });
  const seenEmpty = r => (at.absent?.[r] != null ? now - at.absent[r] : Infinity);
  const d = r => (from == null ? 0 : hops(from, r));
  return [...w.rooms].sort((a, b) =>
    (b === at.rumour) - (a === at.rumour) || seenEmpty(b) - seenEmpty(a) || d(a) - d(b));
}

// ---------------------------------------------------------------- distance
//
// Exit hops over compendium/data/zones.json (the extracted room classes, each with `exits` to a
// RID_ and `ridValue`). Only a RANKING -- "who is closest" -- never a route; the walk step plans
// the real one. Rooms the graph cannot reach (the Temple of Qor's moving door, the Temple of
// Shal'ille's missing one) come back as a large number rather than Infinity so they sort last.
let GRAPH = null;
function graph() {
  if (GRAPH) return GRAPH;
  GRAPH = new Map();
  try {
    const z = JSON.parse(readFileSync(join(REPO, 'compendium', 'data', 'zones.json'), 'utf8'));
    const ridValue = new Map(Object.values(z.rooms ?? {}).map(r => [r.rid, r.ridValue]));
    for (const r of Object.values(z.rooms ?? {})) {
      if (!Number.isFinite(r.ridValue)) continue;
      const out = GRAPH.get(r.ridValue) ?? new Set();
      for (const e of r.exits ?? []) {
        const to = ridValue.get(e.toRid);
        if (!Number.isFinite(to)) continue;
        out.add(to);
        if (!GRAPH.has(to)) GRAPH.set(to, new Set());
        GRAPH.get(to).add(r.ridValue);         // walked both ways for ranking
      }
      GRAPH.set(r.ridValue, out);
    }
  } catch { /* no compendium: every distance is UNREACHED and order falls back to list order */ }
  return GRAPH;
}
export const UNREACHED = 999;
const HOPS = new Map();
export function hops(from, to) {
  from = Number(from); to = Number(to);
  if (from === to) return 0;
  const k = `${from}>${to}`;
  if (HOPS.has(k)) return HOPS.get(k);
  const g = graph();
  const dist = new Map([[from, 0]]);
  const q = [from];
  while (q.length) {
    const r = q.shift();
    for (const n of g.get(r) ?? []) if (!dist.has(n)) { dist.set(n, dist.get(r) + 1); q.push(n); }
  }
  for (const [r, n] of dist) HOPS.set(`${from}>${r}`, n);
  const v = dist.get(to) ?? UNREACHED;
  HOPS.set(k, v);
  return v;
}

// ---------------------------------------------------------------- who goes where
//
// GREEDY CLOSEST-FIRST. Every (body, room) pair sorted by hops; take the shortest pair whose
// body and room are both still free. Then, if rooms are left over, each goes to the body whose
// LAST route room is nearest, so a sweeper walks a short chain rather than across the map.
// `count` limits the bodies used to the N closest to any room on the list.

/**
 * @param rooms  the rooms to cover
 * @param bodies [{ agent, room }]
 * @returns Map agent -> [room, room, ...]  (the first is its post; the rest its sweep)
 */
export function assignPosts(rooms, bodies, { count = Infinity } = {}) {
  const todo = [...new Set(rooms.map(Number))];
  const near = b => Math.min(...todo.map(r => hops(b.room, r)));
  const pool = [...bodies].filter(b => b?.agent).sort((a, b) => near(a) - near(b)).slice(0, Math.max(0, count));
  const pairs = [];
  for (const b of pool) for (const r of todo) pairs.push({ agent: b.agent, room: r, d: hops(b.room, r) });
  pairs.sort((a, b) => a.d - b.d);
  const out = new Map(), taken = new Set();
  for (const p of pairs) {
    if (out.has(p.agent) || taken.has(p.room)) continue;
    out.set(p.agent, [p.room]); taken.add(p.room);
  }
  for (const r of todo.filter(x => !taken.has(x))) {
    let best = null;
    for (const [agent, route] of out) {
      const d = hops(route[route.length - 1], r) + route.length * 2;   // spread the load a little
      if (!best || d < best.d) best = { agent, d };
    }
    if (best) out.get(best.agent).push(r);
  }
  return out;
}

// ---------------------------------------------------------------- the steps
//
// ONE BODY'S WATCH. `slots` walk+look pairs. A body with a ONE-room route walks there once and
// then stands for the whole run inside a single verify, looking every `pollS`. A body with a
// longer route visits its rooms in turn until he is found; in `post` mode, while he is fresh
// somewhere else it parks where it is, and it resumes sweeping when that goes stale.
//
// `state.watch` is per body: { here, next, i, found }. `shared` is per run (in-process), so
// `find` mode can stop every body the moment any of them sees him.

const sleep = ms => new Promise(r => setTimeout(r, ms));
const look = (call, agent) => call('look', { agent }, 30_000).catch(() => null);

//
// `breakWhen({ seen, state, here })` -- optional, async. Asked after every look while standing;
// a truthy answer (a wanderer key) ends the watch with `state.watch.handoff` set to it, so the
// steps after it can act on him (prism-quest.mjs: a scout that is standing with him takes the
// quest itself). The body is still in his room when it returns.
export function watchSteps({ keys, route, mode = 'find', until, pollS = 30, slots = null, shared = { found: null },
                             label = 'watch', onSighting = null, breakWhen = null }) {
  keys = [].concat(keys).map(wandererKey);
  const rooms = [...new Set(route.map(Number))];
  if (!rooms.length) return [];
  const n = slots ?? (rooms.length === 1 ? 1 : Math.max(rooms.length * 3, 12));
  const allRooms = [...new Set(keys.flatMap(k => WANDERERS[k].rooms))];
  // In `find` mode a sighting by ANY process ends the search: the in-run flag, or a fresh ledger entry.
  const expired = () => Date.now() > until ||
    (mode === 'find' && (shared.found || keys.some(k => whereIs(k).fresh)));
  const steps = [];
  for (let i = 0; i < n; i++) {
    steps.push({ ...walk(st => {
      const w = (st.watch ??= { i: 0 });
      if (expired()) return w.here ?? rooms[0];
      return w.next ?? rooms[w.i % rooms.length];
    }, { candidates: allRooms }), optional: true });
    steps.push({ ...verify(async ({ agent, call, state }) => {
      const w = (state.watch ??= { i: 0 });
      if (expired()) return { ok: true, skipped: shared.found ? `found in ${shared.found.room}` : 'run over' };
      const v = await look(call, agent);
      w.here = roomOf(v);
      const report = seen => {
        for (const k of seen) if (keys.includes(k)) {
          shared.found = { key: k, room: w.here, by: agent, at: Date.now() };
          onSighting?.(shared.found);
        }
      };
      let seen = recordView(v, agent).filter(k => keys.includes(k));
      report(seen);
      if (seen.length && mode === 'find') return { ok: true, found: seen, room: w.here };
      const handoff = async () => {
        if (!breakWhen || !seen.length) return null;
        const k = await breakWhen({ seen, state, here: w.here });
        if (k) w.handoff = k;
        return k || null;
      };
      if (await handoff()) return { ok: true, handoff: w.handoff, room: w.here };
      const standing = rooms.length === 1 || seen.length;
      // Stand here: on post, or holding him. Look every pollS until he goes (holding), or until
      // he comes (posted), or the run ends.
      if (standing && mode !== 'find') {
        const held = seen.length > 0;
        while (!expired()) {
          await sleep(pollS * 1000);
          const v2 = await look(call, agent);
          if (roomOf(v2) !== w.here) return { ok: true, moved_off_post: roomOf(v2) };   // keeper or a flee moved us
          seen = recordView(v2, agent).filter(k => keys.includes(k));
          report(seen);
          if (await handoff()) return { ok: true, handoff: w.handoff, room: w.here };
          if (held && !seen.length && rooms.length > 1) break;                       // he left: sweep on
        }
        w.i++; w.next = null;
        return { ok: true, stood: w.here, held };
      }
      if (rooms.length === 1 && mode === 'find') {
        // A one-room finder waits on its post for a fellow to see him, or for him to arrive.
        while (!expired()) {
          await sleep(pollS * 1000);
          report(recordView(await look(call, agent), agent).filter(k => keys.includes(k)));
        }
        return { ok: true, waited_at: w.here };
      }
      // A sweeper: park while he is fresh somewhere (post mode); otherwise on to the next room.
      if (mode === 'post' && keys.some(k => whereIs(k).fresh)) {
        while (!expired() && keys.some(k => whereIs(k).fresh)) await sleep(pollS * 1000);
      }
      w.i++;
      w.next = rooms[w.i % rooms.length];
      return { ok: true, empty: w.here, next: w.next };
    }, `${label}: look for ${keys.map(k => WANDERERS[k].npc).join(' / ')}`), optional: true });
  }
  return steps;
}

/** Bodies with their current rooms, read once. */
export async function bodiesOf(call, agents) {
  const out = [];
  for (const agent of agents) {
    const st = await call('status', { agent, brief: true }, 40_000).catch(() => null);
    out.push({ agent, room: Number(st?.room?.num ?? st?.where?.num ?? NaN) });
  }
  return out;
}

// ONE ASSIGNMENT PER RUN. Every body's `steps()` is called separately; the first computes the
// plan and the rest reuse it, keyed on the run's signature and a minute of age (the REPL keeps
// one module instance across runs, so an older plan belongs to a previous run -- the same rule
// disciple-robes.mjs uses for its pair records).
const PLANS = new Map();
export async function planOnce(sig, make) {
  const old = PLANS.get(sig);
  if (old && Date.now() - old.at < 60_000) return old.plan;
  const rec = { at: Date.now(), plan: make() };
  PLANS.set(sig, rec);
  rec.plan = await rec.plan;
  return rec.plan;
}
