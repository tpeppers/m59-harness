#!/usr/bin/env node
// WHERE THE UNDERWORLD LETS YOU OUT, AND WHICH OF THOSE DOORS YOU ACTUALLY WANT.
//
//   node tools/m59-underworld.mjs                 the exits, and the pentagram
//   node tools/m59-underworld.mjs <room>          which city is nearest to that room
//
// The Underworld is where you wake up after dying, and it has NO exits in the room
// graph — `CreateStandardExits` sets `plExits = $` and returns (uworld.kod:306). The
// only way out is to walk onto a teleporter, and there are six of them:
//
//   FIVE FIXED PORTALS in a pentagram, each with a destination hard-coded at room
//   construction (uworld.kod:649-662). These are the useful ones and this file is
//   mostly about them: if you want Marion, there is a portal that always goes to
//   Marion, standing in a known place, and you can walk onto it.
//
//   ONE SHIFTING PORTAL, the "rip in space", which re-rolls its destination every
//   5-10 seconds among the same five inns (hellport.kod:57,70) and only tells you
//   where it currently leads if you LOOK at it.
//
// The harness used to know only about the rip. Asking for a named city meant standing
// next to the anomaly polling it for up to three minutes, hoping — while a portal that
// went there every time, without waiting, stood a few squares away. That is the whole
// reason this file exists.
//
// WHY ANYONE CARES WHICH EXIT. Dying is expensive but coming back is worse: everything
// you were carrying is lying on the floor where you died, and the walk back is across
// however much of the world sits between you and it. A character that dies outside
// Jasper and comes out at Barloque has to cross the map to reach its own corpse. So the
// question a caller almost always means is "put me back near where I died", and
// nearestCity() answers it from the room graph rather than from a hunch.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const MAP_FILE   = process.env.M59_MAP_FILE   || here('../substrate/m59-map.json');
const ZONES_FILE = process.env.M59_ZONES_FILE || here('../compendium/data/zones.json');

// ------------------------------------------------------------------ the cities
//
// Every destination the Underworld can reach, with the room the portal actually lands
// you in. RIDs from kod/include/blakston.khd; the names are what the live server calls
// those rooms, which is how they can be checked against a room read.
export const CITY_INNS = {
  Tos:        { inn: 52,   innName: 'Familiars' },
  Barloque:   { inn: 106,  innName: 'Brownestone Inn' },
  Cornoth:    { inn: 153,  innName: 'Cibilo Creek Inn' },
  Marion:     { inn: 202,  innName: 'The Limping Toad Inn and Tavern' },
  Jasper:     { inn: 370,  innName: 'Yonder Inn of Jasper' },
  "Ko'catan": { inn: 2001, innName: 'The Aerie Guest House' },
};
export const CITIES = Object.keys(CITY_INNS);

// ---------------------------------------------------------------- the pentagram
//
// The five fixed portals, from uworld.kod:649-662 — the Create() call gives the
// destination and the NewHold beside it gives the position.
//
// COORDINATES ARE KOD'S, WHICH ARE 1-BASED; the client reports the same squares
// 0-based, because a client col is floor(x/64) and x is (col_kod - 1) * 64 + fine
// (m59-pilot.mjs:118). `clientCol`/`clientRow` are that subtraction, done once here so
// nobody has to remember which convention they are holding. They are a HINT for
// ordering and cross-checking only — identification is by description, below, which
// does not depend on any of this being right.
export const UNDERWORLD_PORTALS = [
  { city: 'Tos',      kodRow: 3,  kodCol: 7,  rsc: 'portal_tos',
    desc: 'Looking in the portal, you see the bustling bar of Familiars.' },
  { city: 'Cornoth',  kodRow: 2,  kodCol: 25, rsc: 'portal_cornoth',
    desc: 'A lazy inn next to a quiet creek rests on the other side of this portal.' },
  { city: 'Barloque', kodRow: 21, kodCol: 30, rsc: 'portal_barloque',
    desc: 'Gazing into the portal, you see an expensive inn in a bustling city.' },
  { city: 'Marion',   kodRow: 32, kodCol: 16, rsc: 'portal_marion',
    desc: 'Through the portal, you see the laid-back atmosphere of the Limping Toad.' },
  { city: 'Jasper',   kodRow: 21, kodCol: 2,  rsc: 'portal_jasper',
    desc: 'The quiet Yonder Inn of Jasper lies through this portal.' },
].map(p => ({ ...p, clientRow: p.kodRow - 1, clientCol: p.kodCol - 1,
              inn: CITY_INNS[p.city].inn, innName: CITY_INNS[p.city].innName }));

export const portalFor = (city) =>
  UNDERWORLD_PORTALS.find(p => p.city.toLowerCase() === String(city || '').toLowerCase()) ?? null;

// NOT EVERY PORTAL IS ALIGHT. ResetPuzzle (uworld.kod:460) turns one or two of the five
// off at random, and an unlit portal is SILENT — Portal.SomethingMoved returns
// immediately when it is not animating, so standing on a dead one does nothing at all
// and looks exactly like a portal that does not work. So three or four of the five are
// live at any moment, which is much better than the "dead until you light a brazier"
// the old note claimed, but it is never a guarantee for one particular city.
export const PENTAGRAM_UNLIT_MIN = 1, PENTAGRAM_UNLIT_MAX = 2;

// ------------------------------------------------------- reading a portal's sign
//
// The fixed portals and the rip describe the SAME destinations in DIFFERENT words, and
// the old table only had the rip's. That is not cosmetic: it could not read the fixed
// Cornoth or Barloque portal at all, because those two are the ones whose wording
// differs most ("a lazy inn next to a quiet creek" vs "the Cibilo Creek Inn").
//
// Fixed: uworld.kod:31-35. Rip: hellport.kod:27-33, substituted into
// "Gazing through the anomaly, you can see %s."
export const PORTAL_SIGNS = [
  { city: 'Tos',        match: /bustling bar of Familiars/i },
  { city: 'Marion',     match: /Limping Toad/i },
  { city: 'Jasper',     match: /Yonder Inn of Jasper/i },
  { city: 'Cornoth',    match: /Cibilo Creek Inn|lazy inn next to a quiet creek/i },
  { city: 'Barloque',   match: /Brownstone Inn|expensive inn in a bustling city/i },
  { city: "Ko'catan",   match: /island fortress of Ko'catan/i },
];

// The rip says so about itself. Worth telling apart from a fixed portal, because what
// the two descriptions MEAN is different: a fixed portal's is permanent, and the rip's
// is true for the next few seconds only.
export const RIP_NAME = /rip in space/i;
export const RIP_DESC = /through the anomaly/i;

export function readPortalSign(desc, name = '') {
  const text = desc || '';
  const city = PORTAL_SIGNS.find(d => d.match.test(text))?.city ?? null;
  const shifting = RIP_DESC.test(text) || RIP_NAME.test(name || '');
  return {
    city, shifting,
    // Said explicitly because acting on it differs. A fixed portal can be walked to at
    // leisure; the rip has to be stepped on within a few seconds of being read.
    stable: city !== null && !shifting,
    ...(shifting ? { note: 'the rip re-rolls every 5-10 seconds — this reading is only ' +
                           'good for the next few seconds' } : {}),
  };
}

// Kept for callers that had the old name. The rip's own six strings.
export const RIP_DESTINATIONS = PORTAL_SIGNS;
export const readRipDestination = (text) => readPortalSign(text).city;

// KO'CATAN IS NOT IN THE PENTAGRAM, and cannot be reached by wanting it.
//
// There is no fixed portal to Ko'catan, and the rip does not offer it either — its five
// possible destinations are the mainland inns (hellport.kod:57). The single exception is
// a character who DIED in Ko'catan: NewDeath sets PFLAG2_KOCATAN_DEATH (uworld.kod:598),
// and for that character the rip shows the island and nothing else, and takes them there
// regardless of where it currently points (hellport.kod:106,148).
//
// So it is not a choice. If you died there, the rip is a Ko'catan-only door until you
// use it; if you did not, no exit from the Underworld goes there at all.
export const KOCATAN_IS_DEATH_ONLY =
  "Ko'catan has no portal in the pentagram, and the rip only offers it to a character " +
  "who died in Ko'catan (PFLAG2_KOCATAN_DEATH, uworld.kod:598). For such a character " +
  "the rip goes to Ko'catan and nowhere else. For anyone else it is unreachable from " +
  'the Underworld — leave the city unset and take the nearest working portal.';

// -------------------------------------------------------------- nearest city
//
// Which city a room belongs to, by shortest path through the room graph.
//
// Answered from the graph rather than from a name or a hand-drawn region list, because
// the question is "how far is the walk back to my corpse", and that is a distance. The
// regions in the compendium are an editorial grouping and disagree with travel time in
// exactly the places it matters — a wilderness room can be named after one city and be
// three rooms from a different one.

let _table = null;

function loadJSON(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

// Room graph as an UNDIRECTED adjacency map. Exits are recorded per room and mostly
// come in pairs, but not always — a door recorded on one side only is still a door you
// can walk through, and treating the graph as directed would make some rooms
// unreachable from any city for no reason on the ground.
function buildAdjacency(rooms) {
  const adj = new Map(Object.keys(rooms).map(n => [Number(n), new Set()]));
  for (const key of Object.keys(rooms)) {
    const n = Number(key);
    for (const e of [...(rooms[key].edgeExits || []), ...(rooms[key].goExits || [])]) {
      if (!e || !adj.has(e.to)) continue;
      adj.get(n).add(e.to);
      adj.get(e.to).add(n);
    }
  }
  return adj;
}

export function cityTable({ mapFile = MAP_FILE, zonesFile = ZONES_FILE } = {}) {
  if (_table) return _table;
  const map = loadJSON(mapFile);
  const rooms = map?.rooms ?? null;
  const best = new Map();

  if (rooms) {
    const adj = buildAdjacency(rooms);
    for (const [city, { inn }] of Object.entries(CITY_INNS)) {
      if (!adj.has(inn)) continue;
      const dist = new Map([[inn, 0]]);
      const queue = [inn];
      for (let i = 0; i < queue.length; i++) {
        const u = queue[i];
        for (const v of adj.get(u) || []) {
          if (dist.has(v)) continue;
          dist.set(v, dist.get(u) + 1);
          queue.push(v);
        }
      }
      for (const [room, hops] of dist) {
        const cur = best.get(room);
        // Ties go to the city whose name sorts first, so the same room always gets the
        // same answer. An arbitrary but STABLE tie-break beats one that depends on
        // object key order, because this feeds a decision that gets audited later.
        if (!cur || hops < cur.hops || (hops === cur.hops && city < cur.city))
          best.set(room, { city, hops, how: 'room graph' });
      }
    }
  }

  // Rooms the graph cannot reach. Raza and Hazar are the real cases: the newbie zones
  // are one-way — the museum portal goes out and nothing comes back — so no path exists
  // and none should be invented. The compendium's region is the honest fallback there,
  // and it is labelled differently so a caller can tell a measured answer from a filed
  // one.
  const zones = loadJSON(zonesFile);
  if (zones?.rooms) {
    const regionCity = { 'Cor Noth': 'Cornoth', 'Ko’catan': "Ko'catan", "Ko'catan": "Ko'catan" };
    for (const r of Object.values(zones.rooms)) {
      const num = r.ridValue;
      if (!Number.isFinite(num) || best.has(num)) continue;
      const city = regionCity[r.region] ?? (CITY_INNS[r.region] ? r.region : null);
      if (city) best.set(num, { city, hops: null, how: 'compendium region' });
    }
  }

  _table = best;
  return best;
}

// The answer, for one room. `null` city is a real answer and must be passed through
// rather than defaulted: the Underworld itself, the newbie zones and a handful of
// unvisited wilderness rooms genuinely have no nearest city, and quietly picking Tos
// for them would send characters to the wrong side of the world with no way to tell.
export function nearestCity(roomNum, opts = {}) {
  const n = Number(roomNum);
  if (!Number.isFinite(n)) return { city: null, why: 'no room number given' };
  const hit = cityTable(opts).get(n);
  if (!hit)
    return { city: null, room: n,
             why: 'no path from this room to any city inn in the room graph, and no region ' +
                  'filed for it. Raza and Hazar are the usual cause — the newbie zones are ' +
                  'one-way — and the Underworld itself has no exits at all.' };
  return { city: hit.city, room: n, hops: hit.hops, by: hit.how,
           inn: CITY_INNS[hit.city].innName, inn_room: CITY_INNS[hit.city].inn };
}

// Every city ranked by distance from a room, so a caller that cannot get its first
// choice has somewhere to go next. This is what makes a dead portal survivable: the
// second-nearest city is usually a much shorter walk than waiting for the rip.
export function citiesByDistance(roomNum, opts = {}) {
  const map = loadJSON(opts.mapFile ?? MAP_FILE);
  const rooms = map?.rooms;
  const n = Number(roomNum);
  if (!rooms || !Number.isFinite(n) || !rooms[n]) return [];
  const adj = buildAdjacency(rooms);
  const dist = new Map([[n, 0]]);
  const queue = [n];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    for (const v of adj.get(u) || []) {
      if (dist.has(v)) continue;
      dist.set(v, dist.get(u) + 1);
      queue.push(v);
    }
  }
  return Object.entries(CITY_INNS)
    .map(([city, { inn, innName }]) => ({ city, inn, innName, hops: dist.get(inn) ?? null }))
    .filter(x => x.hops !== null)
    .sort((a, b) => a.hops - b.hops || a.city.localeCompare(b.city));
}

// ---------------------------------------------------------------------- cli
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (arg) {
    const map = loadJSON(MAP_FILE);
    const room = map?.rooms?.[Number(arg)];
    console.log(`room ${arg}${room ? ` — ${room.name}` : ''}`);
    console.log('  nearest city:', JSON.stringify(nearestCity(arg)));
    const ranked = citiesByDistance(arg);
    if (ranked.length) {
      console.log('  every city, by distance:');
      for (const r of ranked) console.log(`    ${String(r.hops).padStart(3)} hops  ${r.city} (${r.innName})`);
    }
  } else {
    console.log('The Underworld has no exits in the room graph. Six teleporters, and that is all.\n');
    console.log('The pentagram — fixed destinations, 1 or 2 unlit at random:');
    for (const p of UNDERWORLD_PORTALS)
      console.log(`  ${p.city.padEnd(9)} kod row ${String(p.kodRow).padStart(2)}, col ${String(p.kodCol).padStart(2)}` +
                  `   (client ${p.clientRow},${p.clientCol})  -> room ${p.inn} ${p.innName}`);
    console.log('\nThe rip in space — re-rolls every 5-10s among those same five inns.');
    console.log(`\nKo'catan: ${KOCATAN_IS_DEATH_ONLY}`);
    const t = cityTable();
    const byCity = {};
    for (const v of t.values()) byCity[v.city] = (byCity[v.city] || 0) + 1;
    console.log(`\nnearest-city table: ${t.size} rooms —`, JSON.stringify(byCity));
  }
}
