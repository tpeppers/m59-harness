#!/usr/bin/env node
// IS THIS FARM WORKING? A ROOM'S KILLS AGAINST WHAT THE ROOM CAN MAKE, AND WHERE THE TIME WENT.
//
//   node tools/m59-roomyield.mjs --fleet prod --since 6h --creature troll
//   node tools/m59-roomyield.mjs --fleet prod --from 2026-10-17T04:30Z --to 2026-10-17T10:30Z --creature troll
//   node tools/m59-roomyield.mjs --fleet prod --since 3h --rooms 38,39        # the castle, any quarry
//   node tools/m59-roomyield.mjs ... --who t1,t2,t3          # one arm of an A/B, by agent or name
//   node tools/m59-roomyield.mjs ... --json
//
// "Kills per 30 minutes" is the number the operator judges a farm by, and on its own it cannot
// say WHY a farm is slow. Three different failures produce the same low number and want three
// different fixes, so this prints all three beside it:
//
//   1. TIME SHARE — how many character-hours were actually spent in the room. Measured
//      2026-10-17 04:30-10:30Z on the troll wheel: Ukgoth (599) got 14% of the crew's time and
//      East Jasper (350), the stage room, got 23%. The farm was a road with a room on it.
//   2. THE CEILING — what the room's generator can make. A room spawns on a fixed clock that
//      does NOT scale with who is standing in it (`vbScaleSpawnRateWithPlayers = FALSE`,
//      monsroom.kod:22, so GetMonsterGenTime always divides by the five-player maximum,
//      monsroom.kod:94-110), and it stops at `piMonster_count_max`. Ukgoth is one troll every
//      ~16s, 218 an hour, 109 per 30 minutes — the most it can ever pay, however many stand in
//      it. A room below its ceiling with few bodies in it is AT ITS CAP, and every spawn tick
//      that lands on a full room is thrown away. A mixed room's cap fills with whatever is not
//      being killed: 597's spiders hold the slots its trolls would spawn into.
//   3. WHAT THE BODIES WERE DOING — the ledger's five-minute samples carry `activity`, and kills
//      carry `from_safe_spot`. 95% of the troll kills in that window were made from a wall, and
//      38% of samples in 599 read "holding a proven safe spot": standing on a wall waiting for
//      something to walk into reach. Same room on 2026-09-28: half the kills in the open.
//
// The residency clock is reconstructed from every row that names a room — the samples, room
// entries, journeys' ends, kills — and any gap longer than `--gap` minutes (default 10, two
// sample periods) is not counted, because a character that went silent is not a character
// standing in the room. That makes char-hours a floor and kills per char-hour a ceiling, and
// both are labelled.
//
// The ceiling assumes the server's SpawnRate setting is the stock 100 (settings.kod:41); pass
// `--spawn-rate` if a server is known to differ. Generator timings come from tools/rooms.json
// (extracted from kod by tools/extract_rooms.py), walked up the class chain for a room that
// inherits MonsterRoom's defaults; the weights from substrate/m59-spawns.json; the join from
// substrate/m59-map.json, whose rooms carry their kod class.
//
// Read-only. Opens no socket, touches no roster, starts no broker.
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LEDGER_FILE = /^fleet-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const SHARED_MS = 1500;

// ------------------------------------------------------------------ pure: the room's ceiling

/** Generator fields for a kod room class, inherited down the class chain. Pure. */
export function generatorOf(roomsByClass, cls) {
  const out = {};
  for (let c = cls, guard = 0; c && guard < 12; c = roomsByClass.get(c)?.parent, guard++) {
    const r = roomsByClass.get(c);
    if (!r) break;
    out.gen_ms ??= num(r.pigen_time);
    out.gen_percent ??= num(r.pigen_percent);
    out.cap ??= num(r.pimonster_count_max);
    if (!out.table && r.plMonsters?.length) out.table = r.plMonsters[0].pairs.map(([k, w]) => [k, Number(w)]);
  }
  return out;
}

/**
 * How many of `match` this room makes in an hour at most. Pure.
 * `entries` are the room's spawn rows ({creature, cls, chance}) from m59-spawns.json.
 * Returns null when the room has no generator this can read.
 */
export function ceilingPerHour(gen, entries, match, { spawnRate = 100 } = {}) {
  if (!gen?.gen_ms || !Array.isArray(entries) || !entries.length) return null;
  const rolled = entries.filter(e => e.how === 'generator' && Number.isFinite(Number(e.chance)));
  const total = rolled.reduce((s, e) => s + Number(e.chance), 0);
  if (!total) return null;
  // TryCreateMonster rolls 1-100 against the running total and makes NOTHING past the end of the
  // table (monsroom.kod:147-170), so weights summing under 100 are a chance of an empty tick.
  const share = rolled.filter(e => match(e.creature) || match(e.cls)).reduce((s, e) => s + Number(e.chance), 0) /
    Math.max(total, 100);
  const tickMs = gen.gen_ms * (spawnRate / 100) / 5;          // monsroom.kod:94-110, never scaled down
  const perTick = (gen.gen_percent ?? 100) / 100;
  return { per_hour: 3_600_000 / tickMs * perTick * share, tick_s: tickMs / 1000, share, cap: gen.cap ?? null };
}

// ------------------------------------------------------------------ pure: where the time went

/** The room a ledger row places its character in, or null. Pure. */
export function roomOfRow(e) {
  if (e.kind === 'travel_map_entered' && Number.isInteger(e.room)) return e.room;
  if (e.kind === 'zone_change' && Number.isInteger(e.ended_in)) return e.ended_in;
  if (Number.isInteger(e.room_num)) return e.room_num;
  return null;
}

/**
 * Character-milliseconds per room per character over [from, to). Pure.
 * `points` is Map<character, [t, room][]> (any order). An interval longer than gapMs is not counted.
 */
export function residency(points, { from, to, gapMs = 10 * 60_000 } = {}) {
  const out = new Map();
  for (const [who, raw] of points) {
    const a = [...raw].sort((x, y) => x[0] - y[0]);
    const mine = new Map();
    for (let i = 0; i < a.length; i++) {
      const [t, room] = a[i];
      const next = i + 1 < a.length ? a[i + 1][0] : to;
      const s = Math.max(t, from), e = Math.min(next, to, t + gapMs);
      if (e > s) mine.set(room, (mine.get(room) ?? 0) + (e - s));
    }
    out.set(who, mine);
  }
  return out;
}

/** The whole report from already-filtered rows. Pure, so the test can feed it rows. */
export function roomYield({ events = [], samples = [], from, to, match = () => true, rooms = null,
                            gapMs = 10 * 60_000, bucketMs = 30 * 60_000, ceilings = new Map() } = {}) {
  const points = new Map();
  const push = (who, t, room) => { if (who && room != null) (points.get(who) ?? points.set(who, []).get(who)).push([t, room]); };
  for (const s of samples) push(s.character, s.t, Number.isInteger(s.room_num) ? s.room_num : null);
  for (const e of events) push(e.character, e.t, roomOfRow(e));
  const res = residency(points, { from, to, gapMs });

  const byRoom = new Map();
  const R = n => byRoom.get(n) ?? byRoom.set(n, { room: n, name: null, ms: 0, kills: 0, other: 0, wall: 0, shared: 0,
    killers: new Set(), present: new Set(), activity: new Map(), samples: 0 }).get(n);
  for (const [who, m] of res) for (const [room, ms] of m) { const r = R(room); r.ms += ms; if (ms >= 60_000) r.present.add(who); }

  const buckets = new Map();
  const lastKill = new Map();     // `${room}|${creature}` -> [t, character] of the previous kill
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.kind !== 'killed' || e.t < from || e.t >= to || !Number.isInteger(e.room_num)) continue;
    const r = R(e.room_num); r.name ??= e.room ?? null;
    if (!match(e.creature)) { r.other++; continue; }
    r.kills++; r.killers.add(e.character); if (e.from_safe_spot) r.wall++;
    // ONE DEATH, TWO ROWS. A keeper records `killed` when its target vanishes, so two characters on
    // one skeleton can both write it, and a kill row carries no monster id to tell them apart.
    // Castle Victoria, 2026-10-16 17:30Z: 843 rows in an hour against a generator that can make 540,
    // and 47% of them shared their creature with another character's row inside 1.5s. Counted, not
    // removed: some of those are two different skeletons dying together, and this cannot tell which.
    const key = `${e.room_num}|${e.creature}`, prev = lastKill.get(key);
    if (prev && prev[1] !== e.character && e.t - prev[0] <= SHARED_MS) r.shared++;
    lastKill.set(key, [e.t, e.character]);
    const b = from + Math.floor((e.t - from) / bucketMs) * bucketMs;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  for (const s of samples) {
    if (s.t < from || s.t >= to || !Number.isInteger(s.room_num)) continue;
    const r = R(s.room_num); r.name ??= s.room ?? null; r.samples++;
    const what = String(s.activity ?? 'unknown').replace(/\d+/g, '#').replace(/:.*$/, '').slice(0, 48);
    r.activity.set(what, (r.activity.get(what) ?? 0) + 1);
  }

  const want = rooms ? new Set(rooms) : null;
  const list = [...byRoom.values()]
    .filter(r => want ? want.has(r.room) : r.kills > 0)
    .map(r => {
      const hours = r.ms / 3_600_000, span = (to - from) / 3_600_000;
      const ceil = ceilings.get(r.room) ?? null;
      return {
        room: r.room, name: r.name, char_hours: round(hours, 2), present: r.present.size,
        kills: r.kills, other_kills: r.other, killers: r.killers.size,
        kills_per_30m: round(r.kills / span / 2, 1),
        kills_per_char_hour: hours > 0 ? round(r.kills / hours, 1) : null,
        wall_share: r.kills ? round(r.wall / r.kills, 2) : null,
        shared_share: r.kills ? round(r.shared / r.kills, 2) : null,
        ceiling_per_30m: ceil ? round(ceil.per_hour / 2, 1) : null,
        of_ceiling: ceil?.per_hour ? round(r.kills / span / ceil.per_hour, 2) : null,
        spawn_tick_s: ceil ? round(ceil.tick_s, 1) : null, cap: ceil?.cap ?? null,
        activity: [...r.activity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([what, n]) => ({ what, share: round(n / r.samples, 2) })),
      };
    })
    .sort((a, b) => b.kills - a.kills || b.char_hours - a.char_hours);

  // Time share among the characters that killed a match anywhere: the crew, whoever it was.
  const crew = new Set(list.flatMap(r => [...(byRoom.get(r.room)?.killers ?? [])]));
  const crewMs = new Map(); let crewTotal = 0;
  for (const who of crew) for (const [room, ms] of res.get(who) ?? []) { crewMs.set(room, (crewMs.get(room) ?? 0) + ms); crewTotal += ms; }
  const time_share = [...crewMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([room, ms]) => ({ room, name: byRoom.get(room)?.name ?? null, share: round(ms / crewTotal, 2),
                            char_hours: round(ms / 3_600_000, 1) }));
  const total = list.reduce((s, r) => s + r.kills, 0);
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    kills: total, kills_per_30m: round(total / ((to - from) / 1_800_000), 1),
    crew: crew.size, rooms: list, time_share,
    series: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => ({ at: new Date(t).toISOString(), kills: n })),
    gap_minutes: gapMs / 60_000,
  };
}

// An absent field is undefined, never 0 — `Number('')` is 0, and a 0 here stops the class walk
// from inheriting MonsterRoom's real value.
const num = v => { const s = String(v ?? '').trim(); const n = s === '' ? NaN : Number(s); return Number.isFinite(n) ? n : undefined; };
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * ONE ARM OF AN A/B. Keeps the rows of the named characters, by name or by agent id (`t11`).
 * Samples carry only the name, so an agent id is resolved through any event that carries both.
 * Pure.
 */
export function onlyWho(events, samples, who) {
  const want = new Set(who.map(w => String(w).toLowerCase()));
  for (const e of events) if (e.agent && want.has(String(e.agent).toLowerCase()) && e.character) want.add(e.character.toLowerCase());
  const keep = r => want.has(String(r.character ?? '').toLowerCase());
  return { events: events.filter(keep), samples: samples.filter(keep) };
}

// ------------------------------------------------------------------ I/O

export function ledgerFiles(dir, from, to) {
  if (!existsSync(dir)) return [];
  const lo = new Date(from).toISOString().slice(0, 10), hi = new Date(to).toISOString().slice(0, 10);
  return readdirSync(dir).filter(f => { const m = LEDGER_FILE.exec(f); return m && m[1] >= lo && m[1] <= hi; })
    .sort().map(f => join(dir, f));
}

async function readRows(files, from, to) {
  const events = [], samples = [];
  const lookback = from - 3 * 3_600_000;     // a room entered before the window still places a body in it
  for (const f of files) {
    for await (const line of createInterface({ input: createReadStream(f) })) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!(o.t >= lookback && o.t < to)) continue;
      if (o.type === 'sample') samples.push(o);
      else if (o.type === 'event' && (o.kind === 'killed' || roomOfRow(o) != null)) events.push(o);
    }
  }
  return { events, samples };
}

export function loadCeilings(match, { spawnRate = 100, repo = REPO } = {}) {
  const out = new Map();
  try {
    const rooms = JSON.parse(readFileSync(join(repo, 'tools/rooms.json'), 'utf8'));
    const byClass = new Map(rooms.filter(r => r.class).map(r => [r.class, r]));
    const spawns = JSON.parse(readFileSync(join(repo, 'substrate/m59-spawns.json'), 'utf8')).rooms ?? {};
    const map = JSON.parse(readFileSync(join(repo, 'substrate/m59-map.json'), 'utf8')).rooms ?? {};
    for (const [n, entries] of Object.entries(spawns)) {
      const cls = map[n]?.cls;
      const c = cls ? ceilingPerHour(generatorOf(byClass, cls), entries, match, { spawnRate }) : null;
      if (c && c.share > 0) out.set(Number(n), c);
    }
  } catch (e) { out.error = e.message; }
  return out;
}

function parseArgs(argv) {
  const a = { since: '6h', gap: 10, bucket: 30, spawnRate: 100 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--fleet') a.fleet = v(); else if (k === '--dir') a.dir = v();
    else if (k === '--since') a.since = v(); else if (k === '--from') a.from = v(); else if (k === '--to') a.to = v();
    else if (k === '--creature') a.creature = v(); else if (k === '--rooms') a.rooms = v().split(',').map(Number);
    else if (k === '--who') a.who = v().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--gap') a.gap = Number(v()); else if (k === '--bucket') a.bucket = Number(v());
    else if (k === '--spawn-rate') a.spawnRate = Number(v()); else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const duration = s => { const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(String(s)); if (!m) throw new Error(`--since wants 30m, 6h or 2d, not ${s}`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]; };

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).join('\n')); return; }
  const { fleetName, ledgerDirFor } = await import('./m59-fleetpath.mjs');
  const dir = a.dir ?? ledgerDirFor(a.fleet ?? fleetName());
  const to = a.to ? Date.parse(a.to) : Date.now();
  const from = a.from ? Date.parse(a.from) : to - duration(a.since);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('the window is empty or unreadable');
  const re = a.creature ? new RegExp(a.creature, 'i') : null;
  const match = name => !re || re.test(String(name ?? ''));
  const files = ledgerFiles(dir, from - 3 * 3_600_000, to);
  // AN ABSENT DIRECTORY IS NOT AN EMPTY ONE (m59-ledger.mjs readLedger): say which was read.
  if (!files.length) { console.error(`no ledger files for that window in ${dir}${existsSync(dir) ? '' : ' (the directory does not exist)'}`); process.exit(2); }
  let { events, samples } = await readRows(files, from, to);
  if (a.who) ({ events, samples } = onlyWho(events, samples, a.who));
  const ceilings = loadCeilings(match, { spawnRate: a.spawnRate });
  const r = roomYield({ events, samples, from, to, match, rooms: a.rooms ?? null,
                        gapMs: a.gap * 60_000, bucketMs: a.bucket * 60_000, ceilings });
  r.source = { dir, files: files.length, events: events.length, samples: samples.length,
               spawn_rate: a.spawnRate, creature: a.creature ?? null, ceilings_error: ceilings.error ?? null };
  if (a.json) { console.log(JSON.stringify(r, null, 1)); return; }

  const what = a.creature ? `"${a.creature}"` : 'all kills';
  console.log(`${r.from} -> ${r.to}  ${what}: ${r.kills} kills, ${r.kills_per_30m}/30m, ${r.crew} killers`);
  console.log(`read ${files.length} file(s) from ${dir}; residency gaps over ${r.gap_minutes} min not counted, so char-h is a floor\n`);
  console.log('room                              char-h  /30m  /char-h  ceiling/30m  of-ceil  wall  shared  doing (5-min samples)');
  for (const x of r.rooms) {
    const name = `${x.room} ${x.name ?? ''}`.slice(0, 32).padEnd(32);
    const doing = x.activity.map(d => `${Math.round(d.share * 100)}% ${d.what}`).join(', ');
    console.log(`${name}  ${String(x.char_hours).padStart(6)}  ${String(x.kills_per_30m).padStart(4)}  ` +
      `${String(x.kills_per_char_hour ?? '-').padStart(7)}  ${String(x.ceiling_per_30m ?? '-').padStart(11)}  ` +
      `${x.of_ceiling == null ? '      -' : String(Math.round(x.of_ceiling * 100) + '%').padStart(7)}  ` +
      `${x.wall_share == null ? '   -' : String(Math.round(x.wall_share * 100) + '%').padStart(4)}  ` +
      `${x.shared_share == null ? '     -' : String(Math.round(x.shared_share * 100) + '%').padStart(6)}  ${doing}`);
  }
  if (r.rooms.some(x => x.of_ceiling > 1))
    console.log(`\nover 100% of ceiling is not possible: those rows include kills credited to two characters ` +
                `("shared" = same creature, another character, within ${SHARED_MS / 1000}s — an upper bound)`);
  console.log(`\nwhere the killers' time went: ` + r.time_share.map(t => `${t.room}${t.name ? ' ' + t.name.slice(0, 16) : ''} ${Math.round(t.share * 100)}%`).join(', '));
  if (r.series.length > 1) console.log(`per ${a.bucket} min: ` + r.series.map(b => `${b.at.slice(11, 16)} ${b.kills}`).join('  '));
  if (ceilings.error) console.log(`(no ceilings: ${ceilings.error})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
