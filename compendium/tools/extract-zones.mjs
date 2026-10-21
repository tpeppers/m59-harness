#!/usr/bin/env node
// extract-zones.mjs -- everything a room is, out of the room classes.
//
//   node tools/extract-zones.mjs        writes data/zones.json
//
// A room class carries far more than its name. Badland1 is the worked example
// and every mechanism below appears in it (kod/object/active/holder/room/
// monsroom/badland1.kod):
//
//   prRoom      = badland1.roo          the map file the client draws
//   piRoom_num  = RID_BADLAND1          the id every exit elsewhere refers to
//   viTerrain_type                      TERRAIN_ flags
//   viTeleport_row / col                where you arrive
//   plMonsters   = [[&Ant,60],[&Groundworm,40]]      the spawn table, weighted
//   plGenerators = [[22,24],[61,20], …]              where they appear
//   CreateStandardObjects()             Create(&FarenPriestess), Create(&ManaNode)…
//   CreateStandardExits()               plEdge_Exits — walking off the map edge
//
// Rooms connect two ways, and both name the destination by RID:
//   plEdge_Exits = Cons([LEAVE_dir, RID_target, row, col, ROTATE_], …)
//   plExits      = Cons([row, col, RID_target, newrow, newcol, ROTATE_], …)
//
// Everything here is a static read of the source. Nothing is inferred from a
// running server.

import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, M59, loadDB, cls, descendants, ivar, rvar, nameOf, slugify, humanize,
  constNames, flagNames, constValue,
} from './lib.mjs';
import { readRoo } from './roo.mjs';
import { setPieces } from './setpiece.mjs';

const db = loadDB();
const OUT = path.join(ROOT, 'data', 'zones.json');

// A room's region is the directory it lives in; the tree is organised by
// settlement and that is the only grouping the source offers.
const REGIONS = {
  barlqrm: 'Barloque', tosrm: 'Tos', crnthrm: 'Cor Noth', jasperrm: 'Jasper',
  kocarm: 'Ko’catan', marnrm: 'Marion', ghall: 'Guild halls',
  monsroom: 'Wilderness', 'monsroom/kcforest': 'Ko’catan jungle',
  'monsroom/feyforst': 'Fey Forest', 'monsroom/objroom': 'Set pieces',
  'monsroom/bossroom': 'Boss lairs', rentroom: 'Rented rooms',
  guest1: 'Raza', guest2: 'Raza', guest3: 'Raza', guest4: 'Raza',
  guest5: 'Raza', guest6: 'Raza', guest7: 'Raza', guest8: 'Raza',
  'monsroom/guest6': 'Raza',
};
function regionOf(file) {
  const rel = file.replace(/^kod\/object\/active\/holder\/room\/?/, '');
  const seg = rel.split('/').slice(0, -1);
  for (let n = seg.length; n > 0; n--) {
    const key = seg.slice(0, n).join('/');
    if (REGIONS[key]) return REGIONS[key];
  }
  return 'Outlying areas';
}

// Split a message body into statements so a Create() and the #new_row that
// positions it stay together.
function statements(body) {
  return (body || '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function allBodies(c) {
  return c.messages.map((m) => m.body).join('\n;\n');
}

// Kod class names are case-insensitive, and rooms spell them however they like
// (&Groundworm for GroundWorm).  Every index below is keyed by the canonical
// name, or creature pages looking up GroundWorm find nothing.
const canon = (n) => (cls(db, n) || { name: n }).name;

// plMonsters = [ [&Ant, 60], [&Groundworm, 40] ]
function spawnTable(c) {
  const out = [];
  for (const m of c.messages) {
    const at = m.body.search(/plMonsters\s*=/i);
    if (at < 0) continue;
    const chunk = m.body.slice(at, m.body.indexOf(';', at) + 1);
    for (const g of chunk.matchAll(/\[\s*&(\w+)\s*,\s*(\d+)\s*\]/g)) {
      out.push({ cls: canon(g[1]), weight: parseInt(g[2], 10) });
    }
  }
  return out;
}

function generators(c) {
  for (const m of c.messages) {
    const at = m.body.search(/plGenerators\s*=/i);
    if (at < 0) continue;
    const chunk = m.body.slice(at, m.body.indexOf(';', at) + 1);
    return [...chunk.matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)]
      .map((g) => ({ row: +g[1], col: +g[2] }));
  }
  return [];
}

// Anything the room creates, with where it stands when the source says.
function placedObjects(c) {
  const out = [];
  for (const m of c.messages) {
    for (const st of statements(m.body)) {
      const mk = /Create\(\s*&(\w+)/i.exec(st);
      if (!mk) continue;
      const row = /#new_row\s*=\s*(-?\d+)/i.exec(st);
      const col = /#new_col\s*=\s*(-?\d+)/i.exec(st);
      const extra = {};
      for (const e of st.matchAll(/#(\w+)\s*=\s*([A-Za-z_][\w]*|-?\d+)/g)) {
        if (!/^new_(row|col|angle)$/i.test(e[1]) && e[1].toLowerCase() !== 'what') extra[e[1]] = e[2];
      }
      out.push({
        cls: canon(mk[1]),
        row: row ? +row[1] : null,
        col: col ? +col[1] : null,
        where: m.name,
        extra: Object.keys(extra).length ? extra : undefined,
      });
    }
  }
  return out;
}

// Both exit forms, normalised to { kind, dir, toRid, row, col }.
function exits(c) {
  const out = [];
  const body = allBodies(c);
  for (const st of statements(body)) {
    if (/plEdge_Exits\s*=/i.test(st)) {
      for (const g of st.matchAll(/\[\s*(LEAVE_\w+)\s*,\s*(RID_\w+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/gi)) {
        out.push({ kind: 'edge', dir: g[1].replace(/^LEAVE_/i, '').toLowerCase(), toRid: g[2].toUpperCase(), row: +g[3], col: +g[4] });
      }
    }
    if (/\bplExits\s*=/i.test(st)) {
      for (const g of st.matchAll(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(RID_\w+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/gi)) {
        out.push({ kind: 'square', fromRow: +g[1], fromCol: +g[2], toRid: g[3].toUpperCase(), row: +g[4], col: +g[5] });
      }
    }
  }
  // A room often lists the same destination several times; keep one per pair.
  const seen = new Set();
  return out.filter((e) => {
    const k = e.kind + e.toRid + (e.dir || '') + (e.fromRow ?? '') + (e.fromCol ?? '');
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ---------------------------------------------------------------- build

const rooms = {};
const byRid = {};

for (const c of descendants(db, 'Room')) {
  // Only classes that actually declare a room number are places.
  const own = c.properties.piRoom_num || c.properties.piroom_num;
  if (!own) continue;
  const ridName = /RID_\w+/i.exec(own.expr)?.[0]?.toUpperCase() || null;
  const ridValue = ridName ? constValue(db, ridName) : null;

  // prRoom is a property, not a classvar, so the parser has already attached
  // the resource it names.
  const roomProp = c.properties.prRoom || c.properties.prroom;
  const rooRes = (roomProp && roomProp.rsc) || null;

  const terrain = ivar(db, c, 'viTerrain_type') || 0;
  const permFlags = (ivar(db, c, 'viPermanent_Flags') || 0)
    | ((c.properties.piPermanent_Flags || c.properties.pipermanent_flags || {}).value || 0);

  const rec = {
    cls: c.name,
    slug: slugify(c.name),
    name: nameOf(db, c) || humanize(c.name),
    file: c.file,
    line: c.classLine,
    rid: ridName,
    ridValue,
    region: regionOf(c.file),
    roo: rooRes ? rooRes.value : null,
    music: ((c.properties.prMusic || c.properties.prmusic || {}).rsc || {}).value || null,
    terrain: terrain ? flagNames(db, 'TERRAIN_', terrain).map((f) => f.name) : [],
    flags: permFlags ? flagNames(db, 'ROOM_', permFlags).map((f) => f.name) : [],
    teleport: {
      row: ivar(db, c, 'viTeleport_row'),
      col: ivar(db, c, 'viTeleport_col'),
    },
    monsters: spawnTable(c),
    generators: generators(c),
    objects: placedObjects(c),
    exits: exits(c),
    parent: c.parent,
  };
  // Trigger regions are clipped to the room, so its size has to be read first.
  let dims = null;
  if (rec.roo) {
    const f = path.join(M59, 'resource', 'rooms', rec.roo);
    if (fs.existsSync(f)) {
      try { const roo = readRoo(f); dims = { rows: roo.rows, cols: roo.cols }; }
      catch (e) { /* a room whose map will not parse still gets everything else */ }
    }
  }
  rec.dims = dims;
  Object.assign(rec, setPieces(db, c, dims));
  rooms[c.name] = rec;
  if (ridName && !byRid[ridName]) byRid[ridName] = c.name;
}

// ---- disambiguate.  Several rooms share a name — there are two called "The
// Badlands" and three called "The Sewers of Barloque" — so a link labelled with
// the bare name would be a lie about which one it goes to.
const nameCount = {};
for (const r of Object.values(rooms)) nameCount[r.name] = (nameCount[r.name] || 0) + 1;
const regionCount = {};
for (const r of Object.values(rooms)) {
  if (nameCount[r.name] > 1) {
    const k = r.name + '|' + r.region;
    regionCount[k] = (regionCount[k] || 0) + 1;
  }
}
for (const r of Object.values(rooms)) {
  if (nameCount[r.name] === 1) { r.disp = r.name; continue; }
  r.disp = regionCount[r.name + '|' + r.region] > 1
    ? `${r.name} (${humanize(r.cls)})`
    : `${r.name} (${r.region})`;
}

// ---- resolve exit destinations to room classes, and build the reverse edges
let resolved = 0, dangling = 0;
const inbound = {};
for (const r of Object.values(rooms)) {
  for (const e of r.exits) {
    e.to = byRid[e.toRid] || null;
    if (e.to) {
      resolved++;
      (inbound[e.to] = inbound[e.to] || []).push({ from: r.cls, kind: e.kind, dir: e.dir || null });
    } else dangling++;
  }
}
for (const r of Object.values(rooms)) r.inbound = inbound[r.cls] || [];

// ---- reverse indices a page can use without rescanning
const byMonster = {}, byObject = {};
for (const r of Object.values(rooms)) {
  for (const m of r.monsters) (byMonster[m.cls] = byMonster[m.cls] || []).push({ room: r.cls, weight: m.weight, how: 'generator' });
  for (const o of r.objects) {
    const k = cls(db, o.cls);
    if (k && k.chain.includes('Monster')) {
      (byMonster[o.cls] = byMonster[o.cls] || []).push({ room: r.cls, how: 'placed', row: o.row, col: o.col });
    }
    (byObject[o.cls] = byObject[o.cls] || []).push({ room: r.cls, row: o.row, col: o.col });
  }
}

const stats = {
  rooms: Object.keys(rooms).length,
  withRoo: Object.values(rooms).filter((r) => r.roo).length,
  withExits: Object.values(rooms).filter((r) => r.exits.length).length,
  exitsResolved: resolved,
  exitsDangling: dangling,
  monsterClasses: Object.keys(byMonster).length,
  regions: [...new Set(Object.values(rooms).map((r) => r.region))].sort(),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ builtAt: null, stats, byRid, rooms, byMonster, byObject }, null, 1));

console.log(`rooms: ${stats.rooms}  (${stats.withRoo} with a map file, ${stats.withExits} with exits)`);
console.log(`exits: ${resolved} resolved, ${dangling} pointing at no known room`);
console.log(`monsters placed by rooms: ${stats.monsterClasses} classes`);
console.log(`regions: ${stats.regions.join(', ')}`);
console.log(`wrote ${OUT}`);
