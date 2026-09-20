#!/usr/bin/env node
// A ROOM, DRAWN THE WAY THE MOVER ACTUALLY SEES IT, WITH WHAT HAPPENED IN IT ON TOP.
//
// Movement bugs here are almost never visible in a number. "Ukgoth crossed 7 times out of
// 190" is a true sentence that tells you nothing about WHERE, and the artefacts that would
// tell you — the baked route, the two disagreeing grids, the declared fall-jumps and the
// tactics ledger — live in four files in four shapes, none of which is a picture.
//
// So this puts them in one picture. Everything it draws is read through the same modules the
// broker moves on (`sharedRoomGeometry`, `attachStepMasks`, `bakedPath`), never re-derived,
// because a debugging view that computes its own geometry is a second opinion about the map
// rather than a look at the one in play — and the whole point is to see what the mover sees.
//
//   node tools/m59-roomview.mjs 599                 # -> substrate/roomviews/599-ukgoth.html
//   node tools/m59-roomview.mjs "Cragged" --open    # by name, and open it
//   node tools/m59-roomview.mjs 599 --fleet shadow  # only that fleet's ledger
//   node tools/m59-roomview.mjs 599 --out /tmp/a.html
//
// The output is one self-contained HTML file with its data embedded — no server, no network,
// nothing to keep running. Offline and read-only: it opens no socket and joins nobody.
//
// The traps it is for are in docs/m59-routing.md; the safe-spot predicate it draws is
// argued in docs/m59-policy.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

import { sharedRoomGeometry, DIR } from './m59-roo.mjs';
import { attachStepMasks, bakedPath } from './m59-routes.mjs';
import { replay } from './m59-routebake.mjs';
import { safeSpots, gridDisagreementAt } from './m59-safespots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sub = (...p) => path.join(ROOT, 'substrate', ...p);

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '').slice(0, 40);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Every square in the room, on the predicates that disagree with each other.
//
// Kept as one character per square in a string per row rather than an array of objects:
// 4,686 squares is a SMALL room here, and a page that parses 30,000 objects before it paints
// is a page nobody waits for.
function gridsFor(geo, rows, cols) {
  const walkable = [], standable = [], moverDegree = [], disagreeRefused = [], disagreeOffered = [];
  const dirs = Object.values(DIR);
  for (let r = 1; r <= rows; r++) {
    let w = '', s = '', m = '', dr = '', dof = '';
    for (let c = 1; c <= cols; c++) {
      w += geo.walkable(r, c) ? '1' : '0';
      let st = false; try { st = !!geo.standable(r, c); } catch {}
      s += st ? '1' : '0';
      // How many of the eight neighbours the MOVER will actually land you on. This is the
      // predicate the router has to plan against (docs/m59-routing.md), and a corridor one
      // square wide reads here as a thread of 2s through a field of 8s.
      let n = 0;
      for (const v of dirs) {
        try { if (geo.moverStepLands(r, c, r + v.dr, c + v.dc)) n++; } catch {}
      }
      m += n.toString(16);
      let d = null; try { d = gridDisagreementAt(geo, r, c); } catch {}
      dr += Math.min(15, d?.refused ?? 0).toString(16);
      dof += Math.min(15, d?.offered ?? 0).toString(16);
    }
    walkable.push(w); standable.push(s); moverDegree.push(m);
    disagreeRefused.push(dr); disagreeOffered.push(dof);
  }
  return { walkable, standable, moverDegree, disagreeRefused, disagreeOffered };
}

// The ledger says "could not get on at 5,65: no_ground_gained" and "rejoined at 35 of 108 —
// slipped at 37". Both name a PLACE and neither is machine-readable until somebody reads it.
// Parsing prose is ugly; leaving the only record of where a crossing broke unplottable is
// worse.
// SERIALIZED CONTRACT: the first note's numeric pair is `row,col`, and this exact
// legacy wording is parsed below. Human diagnostics should add labels elsewhere,
// not rewrite historical ledger notes without versioning this reader.
function parseTactics(rows, routes) {
  const boarding = {}, slips = [], other = {};
  for (const t of rows) {
    const note = t.note || '';
    let m = note.match(/could not get on at (\d+),(\d+)(?::\s*(.*))?/);
    if (m) {
      const key = m[1] + ',' + m[2], why = (m[3] || '?').trim() || '?';
      boarding[key] ??= { row: +m[1], col: +m[2], n: 0, reasons: {} };
      boarding[key].n++;
      boarding[key].reasons[why] = (boarding[key].reasons[why] || 0) + 1;
      continue;
    }
    m = note.match(/rejoined at (\d+) of (\d+)[^]*?slipped at (\d+)/);
    if (m) { slips.push({ at: +m[1], of: +m[2], slipped: +m[3], t: t.t, tactic: t.tactic }); continue; }
    if (note) other[note] = (other[note] || 0) + 1;
  }
  // Put each slip on the map by finding the route whose length it counted against. A slip
  // index means nothing alone — "37 of 108" is only a square once you know WHICH path had
  // 108 squares in it. Where no route matches, the slip still counts and says so, rather
  // than being quietly dropped or, worse, drawn on the wrong path.
  for (const s of slips) {
    let hit = null;
    for (const [key, r] of Object.entries(routes)) {
      for (const [which, squares] of [['sent', r.sent], ['squares', r.squares]]) {
        if (!Array.isArray(squares) || squares.length !== s.of) continue;
        hit = { key, which,
                square: squares[Math.min(s.slipped, squares.length - 1)],
                boarded: squares[Math.min(s.at, squares.length - 1)] };
        break;
      }
      if (hit) break;
    }
    s.on = hit;
  }
  return { boarding, slips, other };
}

// EVERY CHARACTER NAME THIS MACHINE KNOWS, so none of them rides out inside a file.
//
// The page shows aggregates and never a name, but the ledgers it reads are full of them —
// a tactics note says `agent "shadow05" is not in game`, and that sentence is embedded
// verbatim. A roster file IS the credential store, so this reads only the slot names and
// any character field out of it and never touches the passwords beside them.
function knownNames() {
  const names = new Set();
  const add = n => { if (typeof n === 'string' && n.length > 2) names.add(n); };
  // A ROSTER SLOT IS A KEY WHOSE VALUE CARRIES CREDENTIALS, not every key in the file.
  // Taking every key swept up words like "fleet" and "version", and a redactor that
  // replaces the word "fleet" in a note does more damage than the name it was hiding.
  const rosters = [sub('fleet-state.json')];
  const fleetDir = sub('fleets');
  if (fs.existsSync(fleetDir))
    for (const f of fs.readdirSync(fleetDir)) if (f.endsWith('.json')) rosters.push(path.join(fleetDir, f));
  for (const file of rosters) {
    const r = readJson(file); if (!r || typeof r !== 'object') continue;
    for (const [slot, v] of Object.entries(r)) {
      if (!v || typeof v !== 'object') continue;
      if (!v.credentials && !v.account && !v.password) continue;
      add(slot);
      add(v.character); add(v.name);
      if (v.credentials && typeof v.credentials === 'object') { add(v.credentials.character); add(v.credentials.name); }
    }
  }
  // A transit log states the character it belongs to; the filename only usually agrees.
  const tdir = sub('transits');
  if (fs.existsSync(tdir))
    for (const f of fs.readdirSync(tdir)) {
      if (!f.endsWith('.json')) continue;
      add(readJson(path.join(tdir, f))?.character);
    }
  // Longest first, so "shadow2" cannot half-redact "shadow21".
  return [...names].sort((x, y) => y.length - x.length);
}

function redactor() {
  const names = knownNames();
  if (!names.length) return t => t;
  return t => {
    if (typeof t !== 'string') return t;
    for (const n of names) t = t.split(n).join('<agent>');
    return t;
  };
}

// Redact every string in a structure, not the one field somebody remembered.
//
// The first version redacted `note` on a tactics row, and a character name walked out
// anyway inside a crossing's `reason` — the game's own sentence, "### Aaaa was just killed
// by a groundworm". Free text arrives from the wire in whichever field the wire chose, so
// the safe shape is to walk the whole object. Room names are exempt: they are fixed strings
// from the map, and a character sharing a word with one must not rewrite the map.
const NEVER_REDACT = new Set(['room_name', 'to_name', 'rooFile', 'name']);
function deepRedact(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => deepRedact(v, redact));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = NEVER_REDACT.has(k) ? v : deepRedact(v, redact);
    return out;
  }
  return value;
}

export function collectRoom(roomNum, { fleets = null } = {}) {
  const world = readJson(sub('m59-map.json'));
  if (!world?.rooms) throw new Error('no world map at ' + sub('m59-map.json') + ' — run: node tools/setup.mjs routes');

  // The step masks are what make this the MOVER's geometry rather than a stricter guess.
  // Without them `moverStepLands` falls back to the coarse grid and every picture drawn here
  // is of a map the fleet is not walking on — so the count is reported on the page rather
  // than assumed, the same way `m59-routes.mjs` reports it at broker start.
  let masks;
  try { masks = attachStepMasks(world); }
  catch (e) { masks = { attached: 0, ok: false, why: e.message }; }

  const room = world.rooms[String(roomNum)];
  if (!room) throw new Error('no room ' + roomNum + ' in the map');
  const rows = room.rows, cols = room.cols;
  const geo = sharedRoomGeometry(room);

  const table = readJson(sub('m59-routes.json'), { rooms: {} });
  const baked = table.rooms?.[String(roomNum)] || null;

  const routes = {};
  for (const key of Object.keys(baked?.routes || {})) {
    const [from, to] = key.split('>').map(p => {
      const [row, col] = p.split(',').map(Number); return { row, col };
    });
    let squares = [], sent = [];
    try { squares = replay(from.row, from.col, baked.routes[key]).map(s => [s.row, s.col]); } catch {}
    try { sent = (bakedPath(table, roomNum, from, to) || []).map(s => [s.row, s.col]); } catch {}
    routes[key] = { from, to, squares, sent,
                    pivots: baked.pivots?.[key]?.squares || [],
                    unverified: baked.pivots?.[key]?.unverified ?? null };
  }

  // Walls are the only thing here that is the .roo's own shape rather than a grid of squares,
  // which is exactly why they are worth drawing: a route that looks fine on the grid and
  // crosses one of these is the bug.
  const walls = (room.roo?.walls || []).map(w => w.slice(0, 5));
  let extent = 0;
  for (const w of walls) extent = Math.max(extent, w[0], w[1], w[2], w[3]);
  const unitsPerSquare = extent > 0
    ? Math.pow(2, Math.round(Math.log2(extent / Math.max(rows, cols)))) : 1024;

  const redact = redactor();

  const jumpFile = readJson(sub('m59-falljumps.json'), {});
  const jumpList = Array.isArray(jumpFile.jumps) ? jumpFile.jumps
                 : Array.isArray(jumpFile) ? jumpFile : [];
  const jumps = jumpList.filter(j => (j.room ?? j.roomNum) === Number(roomNum));

  // (a `safespots` layer was read from substrate/m59-safespots.json here and drawn beside
  //  the ranked walls. The book is retired — see the tombstone in m59-safespots.mjs — and
  //  `ranked` below, which is computed from geometry, is what it was being checked against.)
  const safespots = {};
  let ranked = [];
  try { ranked = safeSpots(geo, { limit: 60 }) || []; } catch { ranked = []; }

  const tacticsRows = [];
  const tacticsDir = sub('tactics');
  if (fs.existsSync(tacticsDir)) {
    for (const f of fs.readdirSync(tacticsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const name = f.replace(/\.jsonl$/, '');
      if (fleets && !fleets.includes(name)) continue;
      for (const line of fs.readFileSync(path.join(tacticsDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.room !== Number(roomNum)) continue;
        // The name is dropped and the free-text note is redacted: the page counts tactics
        // and plots where they failed, and neither needs to know who it was.
        const { character, ...rest } = row;
        tacticsRows.push({ ...deepRedact(rest, redact), fleet: name });
      }
    }
  }

  const crossings = [];
  const transitsDir = sub('transits');
  if (fs.existsSync(transitsDir)) {
    for (const f of fs.readdirSync(transitsDir)) {
      if (!f.endsWith('.json')) continue;
      const t = readJson(path.join(transitsDir, f));
      for (const row of (t?.transits || [])) {
        if (row.room !== Number(roomNum) && row.to !== Number(roomNum)) continue;
        // WITHOUT THE NAME. The page aggregates these by destination and never shows who
        // made the trip, so carrying the name would only be a character list riding out of
        // here inside a file somebody mails to somebody. Same rule bard-guard.mjs enforces
        // one repository over: what leaves names nobody behind.
        const { journey, ...rest } = row;
        crossings.push(deepRedact(rest, redact));
      }
    }
  }

  // Refused moves, when the trace happens to be on. It is off by default and cleared often,
  // so an empty layer here means NOT MEASURED, never "nothing was refused" — which is why the
  // page says which of the two it is instead of drawing an empty layer and letting you guess.
  const refusals = {};
  const trace = sub('collision-trace.jsonl');
  const tracePresent = fs.existsSync(trace);
  if (tracePresent) {
    for (const line of fs.readFileSync(trace, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.room !== Number(roomNum) || row.sent) continue;
      const s = row.square; if (!s || s.row == null) continue;
      const k = s.row + ',' + s.col;
      refusals[k] ??= { row: s.row, col: s.col, n: 0, reasons: {} };
      refusals[k].n++;
      const why = row.reason || '?';
      refusals[k].reasons[why] = (refusals[k].reasons[why] || 0) + 1;
    }
  }

  return {
    room: { num: Number(roomNum), name: room.name, rows, cols, rooFile: room.rooFile },
    exits: room.edgeExits || [],
    anchors: baked?.anchors || [],
    bake: baked ? { regions: baked.regions, main_region: baked.main_region,
                    main_region_squares: baked.main_region_squares,
                    walkable: baked.walkable, pockets: baked.pockets,
                    stranded_exits: baked.stranded_exits } : null,
    grids: gridsFor(geo, rows, cols),
    walls, unitsPerSquare, routes, jumps, safespots, ranked,
    tacticsRows, tactics: parseTactics(tacticsRows, routes), crossings,
    refusals, tracePresent, traceRows: Object.keys(refusals).length,
    masks: { attached: masks.attached ?? 0, ok: masks.ok !== false, why: masks.why || null },
    builtAt: world.builtAt || null,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The page. One file, no network, no dependencies — the same rule as every tool here.
// ---------------------------------------------------------------------------

const PAGE = `<title>__TITLE__</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;450;600&display=swap">
<style>
:root{
  --paper:#E9EDEC; --panel:#FFFFFF; --sunk:#DFE6E4;
  --ink:#0F1A1C; --muted:#5A6B6E; --faint:#8C9B9D; --rule:#C8D2D0;
  --rail:#C2551F; --survey:#196A72; --ok:#2F7A50; --bad:#A32E2E; --jump:#6B4C9A;
  --stand:#D3DEDB; --walk:#A9BFBB; --disagree:#6FB0AC;
  --shadow:0 1px 2px rgba(15,26,28,.06),0 8px 24px rgba(15,26,28,.06);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#0B1214; --panel:#131E20; --sunk:#0F191B;
    --ink:#DCE6E4; --muted:#8A9C9E; --faint:#63767A; --rule:#223134;
    --rail:#E4763F; --survey:#3FA8AE; --ok:#57B383; --bad:#DB6A6A; --jump:#A88BDF;
    --stand:#1A2A2C; --walk:#2E464A; --disagree:#2F6B6B;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
  }
}
:root[data-theme="dark"]{
  --paper:#0B1214; --panel:#131E20; --sunk:#0F191B;
  --ink:#DCE6E4; --muted:#8A9C9E; --faint:#63767A; --rule:#223134;
  --rail:#E4763F; --survey:#3FA8AE; --ok:#57B383; --bad:#DB6A6A; --jump:#A88BDF;
  --stand:#1A2A2C; --walk:#2E464A; --disagree:#2F6B6B;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font-family:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;
  font-size:14px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
h1,h2,h3{font-family:"IBM Plex Sans Condensed","IBM Plex Sans",sans-serif;margin:0;text-wrap:balance}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.eyebrow{
  font-family:"IBM Plex Sans Condensed",sans-serif;font-size:11px;font-weight:600;
  letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
}

/* header ------------------------------------------------------------------ */
header{
  display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 20px;
  padding:14px 20px;border-bottom:1px solid var(--rule);background:var(--panel);
}
header h1{font-size:21px;font-weight:700;letter-spacing:-.01em}
header .num{color:var(--rail);font-family:"IBM Plex Mono",monospace;font-weight:600}
header .file{color:var(--muted);font-size:12px}
.stats{display:flex;flex-wrap:wrap;gap:0;margin-left:auto}
.stat{padding:0 16px;border-left:1px solid var(--rule);text-align:right}
.stat:first-child{border-left:0}
.stat b{display:block;font-family:"IBM Plex Mono",monospace;font-size:17px;font-weight:600;line-height:1.25}
.stat span{display:block;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.stat.warn b{color:var(--bad)}
.stat.good b{color:var(--ok)}

/* workbench --------------------------------------------------------------- */
main{display:flex;align-items:stretch;height:calc(100vh - 62px);min-height:520px}
#stage{position:relative;flex:1;min-width:0;background:var(--sunk);overflow:hidden}
#map{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair}
#map:active{cursor:grabbing}
.tools{
  position:absolute;left:12px;top:12px;display:flex;gap:6px;z-index:3;
}
.tools button{
  font:500 12px/1 "IBM Plex Sans Condensed",sans-serif;letter-spacing:.03em;
  padding:7px 11px;border:1px solid var(--rule);border-radius:2px;
  background:var(--panel);color:var(--ink);cursor:pointer;box-shadow:var(--shadow);
}
.tools button:hover{border-color:var(--survey);color:var(--survey)}
.tools button:focus-visible{outline:2px solid var(--rail);outline-offset:1px}
.hint{
  position:absolute;left:12px;bottom:12px;z-index:3;color:var(--faint);font-size:11px;
  background:color-mix(in srgb,var(--panel) 80%,transparent);padding:4px 8px;border-radius:2px;
}

/* rail -------------------------------------------------------------------- */
aside{
  width:340px;flex:none;border-left:1px solid var(--rule);background:var(--panel);
  overflow-y:auto;padding:0 0 40px;
}
section{border-bottom:1px solid var(--rule);padding:16px 18px}
section > .eyebrow{margin-bottom:10px}
label.layer{
  display:flex;align-items:center;gap:9px;padding:3px 0;cursor:pointer;font-size:13px;
}
label.layer input{accent-color:var(--survey);margin:0;width:14px;height:14px}
label.layer .sw{width:12px;height:12px;border-radius:2px;flex:none;border:1px solid rgba(0,0,0,.14)}
label.layer .n{margin-left:auto;color:var(--faint);font-size:11px;font-family:"IBM Plex Mono",monospace}
select{
  width:100%;padding:6px 8px;border:1px solid var(--rule);border-radius:2px;
  background:var(--panel);color:var(--ink);font:500 12px "IBM Plex Mono",monospace;
}
/* the hover readout ------------------------------------------------------- */
#readSection{position:sticky;top:0;z-index:2;background:var(--panel);
  box-shadow:0 6px 12px -10px rgba(0,0,0,.5)}
#read{font-family:"IBM Plex Mono",monospace;font-size:12px}
#read .coord{font-size:19px;font-weight:600;color:var(--rail);letter-spacing:.01em}
#read dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0 0}
#read dt{color:var(--faint)}
#read dd{margin:0;text-align:right}
#read .yes{color:var(--ok)}
#read .no{color:var(--bad)}
#read .note{margin-top:8px;padding-top:8px;border-top:1px solid var(--rule);
  font-family:"IBM Plex Sans",sans-serif;color:var(--muted);font-size:12px;line-height:1.45}
/* findings ---------------------------------------------------------------- */
.finding{margin:0 0 12px}
.finding:last-child{margin-bottom:0}
.finding .head{display:flex;align-items:baseline;gap:8px}
.finding .head b{font-family:"IBM Plex Mono",monospace;font-size:13px}
.finding .head .pill{
  font:600 10px/1 "IBM Plex Sans Condensed",sans-serif;letter-spacing:.06em;text-transform:uppercase;
  padding:3px 6px;border-radius:2px;margin-left:auto;
}
.pill.bad{background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}
.pill.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.finding p{margin:3px 0 0;font-size:12px;color:var(--muted);line-height:1.45}
.bar{height:5px;border-radius:3px;background:var(--sunk);overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:var(--bad)}
table.mini{width:100%;border-collapse:collapse;font-family:"IBM Plex Mono",monospace;font-size:11.5px}
table.mini th{text-align:left;font:600 10px/1.6 "IBM Plex Sans Condensed",sans-serif;
  letter-spacing:.06em;text-transform:uppercase;color:var(--faint);padding:0 0 4px;border-bottom:1px solid var(--rule)}
table.mini td{padding:3px 0;border-bottom:1px solid color-mix(in srgb,var(--rule) 50%,transparent)}
table.mini td:not(:first-child){text-align:right}
table.mini tr.clickable{cursor:pointer}
table.mini tr.clickable:hover td{color:var(--rail)}
.foot{padding:14px 18px;color:var(--faint);font-size:11px;line-height:1.5}
@media (max-width:860px){
  main{flex-direction:column;height:auto}
  #stage{height:62vh;min-height:380px}
  aside{width:auto;border-left:0;border-top:1px solid var(--rule)}
  .stats{margin-left:0;width:100%}
  .stat{padding-left:0;padding-right:16px;border-left:0;text-align:left}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>

<header>
  <h1><span class="num" id="hRoom"></span> <span id="hName"></span></h1>
  <span class="file mono" id="hFile"></span>
  <div class="stats" id="hStats"></div>
</header>

<main>
  <div id="stage">
    <div class="tools">
      <button id="bFit" type="button">Fit</button>
      <button id="bIn" type="button">Zoom in</button>
      <button id="bOut" type="button">Zoom out</button>
    </div>
    <canvas id="map"></canvas>
    <div class="hint">Drag to pan · scroll to zoom · hover a square to inspect it</div>
  </div>

  <aside>
    <section id="readSection">
      <div class="eyebrow">Square</div>
      <div id="read"><span class="coord">—</span><p style="color:var(--faint);font-size:12px;margin:4px 0 0">Hover the map.</p></div>
    </section>
    <section>
      <div class="eyebrow">Route drawn</div>
      <select id="routePick"></select>
      <div id="routeMeta" class="mono" style="margin-top:8px;font-size:11.5px;color:var(--muted)"></div>
    </section>
    <section>
      <div class="eyebrow">Layers</div>
      <div id="layers"></div>
    </section>
    <section id="findings"><div class="eyebrow">What happened here</div><div id="findingsBody"></div></section>
    <section id="crossSection"><div class="eyebrow">Crossings</div><div id="crossBody"></div></section>
    <div class="foot" id="foot"></div>
  </aside>
</main>

<script id="roomdata" type="application/json">__DATA__</script>
<script>
(function(){
"use strict";
var D = JSON.parse(document.getElementById('roomdata').textContent);
var ROWS = D.room.rows, COLS = D.room.cols;
var G = D.grids;

function css(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function at(gridRows, r, c){
  if (r < 1 || c < 1 || r > ROWS || c > COLS) return null;
  var row = gridRows[r-1]; return row ? row.charAt(c-1) : null;
}
function hex(gridRows, r, c){ var ch = at(gridRows, r, c); return ch === null ? 0 : parseInt(ch, 16) || 0; }
function isOn(gridRows, r, c){ return at(gridRows, r, c) === '1'; }

/* THE SAFE-SPOT PREDICATE, DRAWN RATHER THAN DESCRIBED — AND IT IS ABOUT APPROACHES.
   The tempting reading of "the two grids disagree" is per-square: BSP says a body fits,
   the coarse grid the monsters path on refuses it. In an outdoor room that is nearly
   worthless — standable() here is true for all 4,686 squares, so the per-square version
   just means "rock", and it is drawn as such rather than as a safe spot.
   What safeSpots() actually gates on is per-APPROACH: of the eight ways in, how many does
   the coarse grid refuse while the mover would allow them. That is the number that makes
   a wall hold, so that is the layer that is on by default. */
function coarseRefuses(r, c){ return isOn(G.standable, r, c) && !isOn(G.walkable, r, c); }
function refusedApproaches(r, c){ return hex(G.disagreeRefused, r, c); }

var rockCount = 0, standCount = 0, walkCount = 0, apprCount = 0, degreeSeen = 0;
for (var r = 1; r <= ROWS; r++) for (var c = 1; c <= COLS; c++){
  if (isOn(G.standable, r, c)) standCount++;
  if (isOn(G.walkable, r, c)) walkCount++;
  if (coarseRefuses(r, c)) rockCount++;
  if (refusedApproaches(r, c) > 0) apprCount++;
  if (hex(G.moverDegree, r, c) > 0) degreeSeen++;
}
var standDegenerate = standCount === ROWS * COLS;

/* ---- annotations, indexed by square so hovering can answer ---- */
var boarding = D.tactics.boarding || {};
var refusals = D.refusals || {};
var ledger = D.safespots || {};
var rankedBy = {}; (D.ranked||[]).forEach(function(s){ if(s && s.row) rankedBy[s.row+','+s.col] = s; });
var slipAt = {};
(D.tactics.slips||[]).forEach(function(s){
  if (!s.on || !s.on.square) return;
  var k = s.on.square[0]+','+s.on.square[1];
  slipAt[k] = slipAt[k] || { n:0, of:s.on.key };
  slipAt[k].n++;
});

var routeKeys = Object.keys(D.routes);
var currentRoute = routeKeys[0] || null;
/* Prefer a route that ends at a real exit anchor — that is the crossing people care about. */
(function(){
  var best = null;
  routeKeys.forEach(function(k){
    var rt = D.routes[k];
    var ex = (D.anchors||[]).filter(function(a){ return a.row===rt.to.row && a.col===rt.to.col; })[0];
    if (ex && (!best || rt.squares.length > D.routes[best].squares.length)) best = k;
  });
  if (best) currentRoute = best;
})();

function routeIndexOf(r, c){
  if (!currentRoute) return null;
  var rt = D.routes[currentRoute], i;
  for (i = 0; i < rt.sent.length; i++) if (rt.sent[i][0]===r && rt.sent[i][1]===c) return { which:'sent', i:i, n:rt.sent.length };
  for (i = 0; i < rt.squares.length; i++) if (rt.squares[i][0]===r && rt.squares[i][1]===c) return { which:'route', i:i, n:rt.squares.length };
  return null;
}

/* ---- layers ---- */
var LAYERS = [
  { id:'floor',    label:'BSP floor (standable)', on:true,  sw:'--stand',    n:standCount },
  { id:'coarse',   label:'Coarse grid (walkable)', on:true, sw:'--walk',     n:walkCount },
  { id:'approach', label:'Refused approaches',     on:true,  sw:'--disagree', n:apprCount },
  { id:'rock',     label:'Coarse refuses the square', on:false, sw:'--disagree', n:rockCount },
  { id:'degree',   label:'Mover step degree',      on:false, sw:'--survey',  n:degreeSeen },
  { id:'walls',    label:'.roo walls',             on:true,  sw:'--ink',     n:D.walls.length },
  { id:'route',    label:'Baked route, per square', on:true, sw:'--survey',  n:null },
  { id:'sent',     label:'What the rail sends',    on:true,  sw:'--rail',    n:null },
  { id:'jumps',    label:'Declared fall-jumps',    on:true,  sw:'--jump',    n:D.jumps.length },
  { id:'exits',    label:'Exits and anchors',      on:true,  sw:'--ink',     n:(D.anchors||[]).length },
  { id:'spots',    label:'Safe spots, tested',     on:true,  sw:'--ok',      n:Object.keys(ledger).length },
  { id:'ranked',   label:'Safe spots, scored',     on:false, sw:'--survey',  n:(D.ranked||[]).length },
  { id:'fails',    label:'Boarding failures',      on:true,  sw:'--bad',     n:Object.keys(boarding).length },
  { id:'slips',    label:'Slipped off the rail',   on:true,  sw:'--bad',     n:Object.keys(slipAt).length },
  { id:'refuse',   label:'Refused moves',          on:true,  sw:'--bad',     n:Object.keys(refusals).length }
];
var show = {};
LAYERS.forEach(function(l){ show[l.id] = l.on; });

var layersEl = document.getElementById('layers');
LAYERS.forEach(function(l){
  var lab = document.createElement('label');
  lab.className = 'layer';
  var box = document.createElement('input');
  box.type = 'checkbox'; box.checked = l.on;
  box.addEventListener('change', function(){ show[l.id] = box.checked; draw(); });
  var sw = document.createElement('span');
  sw.className = 'sw'; sw.style.background = 'var(' + l.sw + ')';
  var txt = document.createElement('span'); txt.textContent = l.label;
  lab.appendChild(box); lab.appendChild(sw); lab.appendChild(txt);
  if (l.n !== null && l.n !== undefined){
    var n = document.createElement('span'); n.className = 'n';
    n.textContent = l.n === 0 ? '—' : String(l.n);
    if (l.n === 0) lab.style.opacity = '.5';
    lab.appendChild(n);
  }
  layersEl.appendChild(lab);
});

/* ---- canvas ---- */
var cv = document.getElementById('map'), ctx = cv.getContext('2d');
var view = { s: 8, x: 0, y: 0 };
var hover = null, pinned = null;

function resize(){
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
function fit(){
  var w = cv.clientWidth, h = cv.clientHeight, pad = 24;
  view.s = Math.max(1, Math.min((w - pad*2) / COLS, (h - pad*2) / ROWS));
  view.x = (w - COLS * view.s) / 2;
  view.y = (h - ROWS * view.s) / 2;
  draw();
}
function px(col){ return view.x + (col - 1) * view.s; }
function py(row){ return view.y + (row - 1) * view.s; }
function sqAt(mx, my){
  var c = Math.floor((mx - view.x) / view.s) + 1, r = Math.floor((my - view.y) / view.s) + 1;
  if (r < 1 || c < 1 || r > ROWS || c > COLS) return null;
  return { row: r, col: c };
}
function centre(sq){ return { x: px(sq[1]) + view.s/2, y: py(sq[0]) + view.s/2 }; }

function draw(){
  var w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = css('--sunk'); ctx.fillRect(0, 0, w, h);
  var s = view.s;

  /* the room's own footprint, so the edge of the map is visible even where nothing stands */
  ctx.fillStyle = css('--panel');
  ctx.globalAlpha = .35;
  ctx.fillRect(px(1), py(1), COLS*s, ROWS*s);
  ctx.globalAlpha = 1;

  var r, c, cs = Math.max(s, 1);
  if (show.degree){
    for (r = 1; r <= ROWS; r++) for (c = 1; c <= COLS; c++){
      var d = hex(G.moverDegree, r, c);
      if (!d) continue;
      ctx.globalAlpha = .12 + (d/8) * .68;
      ctx.fillStyle = css('--survey');
      ctx.fillRect(px(c), py(r), cs, cs);
    }
    ctx.globalAlpha = 1;
  } else {
    if (show.floor){
      ctx.fillStyle = css('--stand');
      for (r = 1; r <= ROWS; r++) for (c = 1; c <= COLS; c++)
        if (isOn(G.standable, r, c)) ctx.fillRect(px(c), py(r), cs, cs);
    }
    if (show.coarse){
      ctx.fillStyle = css('--walk');
      for (r = 1; r <= ROWS; r++) for (c = 1; c <= COLS; c++)
        if (isOn(G.walkable, r, c)) ctx.fillRect(px(c), py(r), cs, cs);
    }
  }
  if (show.rock){
    ctx.fillStyle = css('--disagree'); ctx.globalAlpha = .3;
    for (r = 1; r <= ROWS; r++) for (c = 1; c <= COLS; c++)
      if (coarseRefuses(r, c)) ctx.fillRect(px(c), py(r), cs, cs);
    ctx.globalAlpha = 1;
  }
  if (show.approach){
    /* Eight approaches at most, so the scale is fixed rather than relative to this room —
       two rooms drawn side by side have to mean the same thing by the same colour. */
    for (r = 1; r <= ROWS; r++) for (c = 1; c <= COLS; c++){
      var ra = refusedApproaches(r, c);
      if (!ra) continue;
      ctx.globalAlpha = .22 + (ra / 8) * .62;
      ctx.fillStyle = css('--disagree');
      ctx.fillRect(px(c), py(r), cs, cs);
    }
    ctx.globalAlpha = 1;
  }
  if (show.refuse){
    var maxRef = 1, k;
    for (k in refusals) if (refusals[k].n > maxRef) maxRef = refusals[k].n;
    for (k in refusals){
      var rf = refusals[k];
      ctx.globalAlpha = .25 + .6 * (rf.n / maxRef);
      ctx.fillStyle = css('--bad');
      ctx.fillRect(px(rf.col), py(rf.row), cs, cs);
    }
    ctx.globalAlpha = 1;
  }

  if (show.walls && s > 1.2){
    var u = D.unitsPerSquare;
    ctx.lineWidth = Math.max(1, s * .12);
    ctx.strokeStyle = css('--ink');
    ctx.globalAlpha = .8;
    ctx.beginPath();
    for (var i = 0; i < D.walls.length; i++){
      var wl = D.walls[i];
      ctx.moveTo(view.x + (wl[0]/u) * s, view.y + (wl[1]/u) * s);
      ctx.lineTo(view.x + (wl[2]/u) * s, view.y + (wl[3]/u) * s);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  var rt = currentRoute ? D.routes[currentRoute] : null;
  if (rt && show.route && rt.squares.length){
    ctx.strokeStyle = css('--survey'); ctx.globalAlpha = .75;
    ctx.lineWidth = Math.max(1, s * .18);
    ctx.setLineDash([Math.max(2, s*.5), Math.max(2, s*.4)]);
    ctx.beginPath();
    rt.squares.forEach(function(sq, i){
      var p = centre(sq); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  if (rt && show.sent && rt.sent.length){
    /* WHAT IS ACTUALLY SENT, which is not the route. bakedPath() rides the string-pulled
       pivots subdivided at five squares — the client's own packet distance — so this line
       is the packets, and the dashed one behind it is the ground. */
    ctx.strokeStyle = css('--rail');
    ctx.lineWidth = Math.max(1.5, s * .3);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    rt.sent.forEach(function(sq, i){
      var p = centre(sq); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.fillStyle = css('--rail');
    rt.sent.forEach(function(sq){
      var p = centre(sq);
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, s*.2), 0, 6.284); ctx.fill();
    });
    /* the pivots the bake proved, larger, hollow */
    ctx.strokeStyle = css('--rail'); ctx.lineWidth = Math.max(1, s*.14);
    (rt.pivots||[]).forEach(function(sq){
      var p = centre(sq);
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3, s*.42), 0, 6.284); ctx.stroke();
    });
  }

  if (show.jumps){
    ctx.lineWidth = Math.max(1.5, s*.26);
    (D.jumps||[]).forEach(function(j){
      var a = centre([j.from.row, j.from.col]), b = centre([j.to.row, j.to.col]);
      ctx.strokeStyle = css('--jump');
      ctx.setLineDash([Math.max(3, s*.7), Math.max(2, s*.45)]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      var ang = Math.atan2(b.y-a.y, b.x-a.x), hd = Math.max(5, s*.75);
      ctx.fillStyle = css('--jump');
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - hd*Math.cos(ang-0.4), b.y - hd*Math.sin(ang-0.4));
      ctx.lineTo(b.x - hd*Math.cos(ang+0.4), b.y - hd*Math.sin(ang+0.4));
      ctx.closePath(); ctx.fill();
    });
  }

  function ring(sq, colour, rad, width){
    var p = centre(sq);
    ctx.strokeStyle = colour; ctx.lineWidth = width;
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.284); ctx.stroke();
  }
  if (show.ranked) (D.ranked||[]).forEach(function(sp){
    if (!sp || !sp.row) return;
    ring([sp.row, sp.col], css('--survey'), Math.max(2, s*.3), Math.max(1, s*.1));
  });
  if (show.spots) Object.keys(ledger).forEach(function(k){
    var sp = ledger[k];
    var held = (sp.held||0) > 0, failed = (sp.failed||0) > 0;
    var colour = held && !failed ? css('--ok') : failed && !held ? css('--bad') : css('--jump');
    ring([sp.row, sp.col], colour, Math.max(3, s*.5), Math.max(1.5, s*.2));
  });
  if (show.fails) Object.keys(boarding).forEach(function(k){
    var b = boarding[k], p = centre([b.row, b.col]);
    var rad = Math.max(4, s * (0.45 + Math.min(1, b.n/40) * 0.9));
    ctx.fillStyle = css('--bad'); ctx.globalAlpha = .28;
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.284); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--bad'); ctx.lineWidth = Math.max(1.5, s*.2);
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.284); ctx.stroke();
  });
  if (show.slips) Object.keys(slipAt).forEach(function(k){
    var parts = k.split(','), p = centre([+parts[0], +parts[1]]);
    var d = Math.max(3, s*.55);
    ctx.strokeStyle = css('--bad'); ctx.lineWidth = Math.max(1.5, s*.2);
    ctx.beginPath();
    ctx.moveTo(p.x-d, p.y-d); ctx.lineTo(p.x+d, p.y+d);
    ctx.moveTo(p.x+d, p.y-d); ctx.lineTo(p.x-d, p.y+d);
    ctx.stroke();
  });

  if (show.exits){
    ctx.font = '600 ' + Math.max(9, Math.min(13, s*1.1)) + 'px "IBM Plex Sans Condensed", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    (D.anchors||[]).forEach(function(a){
      var p = centre([a.row, a.col]);
      var rad = Math.max(4, s*.65);
      ctx.fillStyle = css('--panel');
      ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.284); ctx.fill();
      ctx.strokeStyle = css('--ink'); ctx.lineWidth = Math.max(1.5, s*.18);
      ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.284); ctx.stroke();
      ctx.fillStyle = css('--ink');
      if (s > 5) ctx.fillText(String(a.to), p.x, p.y + rad + Math.max(7, s*.9));
    });
  }

  var mark = pinned || hover;
  if (mark){
    ctx.strokeStyle = css('--rail'); ctx.lineWidth = 2;
    ctx.strokeRect(px(mark.col) - 1, py(mark.row) - 1, cs + 2, cs + 2);
  }
}

/* ---- interaction ---- */
var drag = null;
cv.addEventListener('mousedown', function(e){
  drag = { x:e.offsetX, y:e.offsetY, vx:view.x, vy:view.y, moved:false };
  /* Take the square from the press itself rather than trusting that a mousemove arrived
     first — a tap, a synthetic click and a pointer that entered over the canvas all skip it. */
  hover = sqAt(e.offsetX, e.offsetY);
  readout(pinned || hover);
});
window.addEventListener('mouseup', function(){
  if (drag && !drag.moved && hover) pinned = pinned && pinned.row===hover.row && pinned.col===hover.col ? null : hover;
  drag = null; draw();
});
cv.addEventListener('mousemove', function(e){
  if (drag){
    if (Math.abs(e.offsetX-drag.x) + Math.abs(e.offsetY-drag.y) > 3) drag.moved = true;
    view.x = drag.vx + (e.offsetX - drag.x); view.y = drag.vy + (e.offsetY - drag.y);
    draw(); return;
  }
  var sq = sqAt(e.offsetX, e.offsetY);
  var changed = (!!sq !== !!hover) || (sq && hover && (sq.row!==hover.row || sq.col!==hover.col));
  hover = sq;
  if (changed){ readout(pinned || hover); draw(); }
});
cv.addEventListener('mouseleave', function(){ hover = null; readout(pinned); draw(); });
cv.addEventListener('wheel', function(e){
  e.preventDefault();
  var f = e.deltaY < 0 ? 1.15 : 1/1.15;
  var ns = Math.max(1, Math.min(60, view.s * f));
  view.x = e.offsetX - (e.offsetX - view.x) * (ns / view.s);
  view.y = e.offsetY - (e.offsetY - view.y) * (ns / view.s);
  view.s = ns; draw();
}, { passive:false });
document.getElementById('bFit').addEventListener('click', fit);
document.getElementById('bIn').addEventListener('click', function(){ zoomBy(1.3); });
document.getElementById('bOut').addEventListener('click', function(){ zoomBy(1/1.3); });
function zoomBy(f){
  var cx = cv.clientWidth/2, cy = cv.clientHeight/2;
  var ns = Math.max(1, Math.min(60, view.s * f));
  view.x = cx - (cx - view.x) * (ns/view.s);
  view.y = cy - (cy - view.y) * (ns/view.s);
  view.s = ns; draw();
}

/* ---- the readout ---- */
function esc(t){ return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function readout(sq){
  var el = document.getElementById('read');
  if (!sq){ el.innerHTML = '<span class="coord">—</span><p style="color:var(--faint);font-size:12px;margin:4px 0 0">Hover the map.</p>'; return; }
  var r = sq.row, c = sq.col, k = r + ',' + c;
  var stand = isOn(G.standable, r, c), walk = isOn(G.walkable, r, c);
  var deg = hex(G.moverDegree, r, c);
  var ref = hex(G.disagreeRefused, r, c), off = hex(G.disagreeOffered, r, c);
  var h = '<span class="coord">' + r + ',' + c + '</span>';
  h += '<dl>';
  h += '<dt>BSP floor</dt><dd class="' + (stand?'yes':'no') + '">' + (stand?'stands':'no floor') + '</dd>';
  h += '<dt>coarse grid</dt><dd class="' + (walk?'yes':'no') + '">' + (walk?'walkable':'refused') + '</dd>';
  h += '<dt>mover steps out</dt><dd>' + deg + ' of 8</dd>';
  h += '<dt>approaches</dt><dd>' + ref + ' refused / ' + off + ' offered</dd>';
  var ri = routeIndexOf(r, c);
  if (ri) h += '<dt>on route</dt><dd>' + (ri.which==='sent'?'packet ':'square ') + ri.i + ' of ' + ri.n + '</dd>';
  h += '</dl>';
  var notes = [];
  if (ref > 0) notes.push('<b>' + ref + ' of the ' + (ref + off) + ' ways in are refused</b> by the coarse grid the monsters path on. That gap is what makes a wall hold, and it is the number safeSpots() scores.');
  if (stand && !walk) notes.push('The coarse grid refuses this square, but <b>the mover will still step onto it</b> — moverStepLands() allows a fine-only destination by default; set M59_CLIP_STEPS=0 for the strict rule and it will not.');
  var anch = (D.anchors||[]).filter(function(a){ return a.row===r && a.col===c; })[0];
  if (anch) notes.push('Exit anchor: <b>' + esc(anch.dir) + '</b> to room <b>' + anch.to + '</b>' + (anch.from_body ? ', reachable from the main body' : ', <b>not</b> reachable from the main body'));
  if (boarding[k]){
    var b = boarding[k], why = Object.keys(b.reasons).map(function(x){ return esc(x) + ' \\u00d7' + b.reasons[x]; }).join(', ');
    notes.push('<b>' + b.n + ' failed attempts to get on the rail here</b> — ' + why);
  }
  if (slipAt[k]) notes.push('<b>Slipped off the rail here ' + slipAt[k].n + '\\u00d7</b>');
  if (refusals[k]){
    var rf = refusals[k], w2 = Object.keys(rf.reasons).map(function(x){ return esc(x) + ' \\u00d7' + rf.reasons[x]; }).join(', ');
    notes.push(rf.n + ' refused moves from this square — ' + w2);
  }
  if (ledger[k]){
    var sp = ledger[k];
    notes.push('Tested as a safe spot: <b>held ' + (sp.held||0) + '</b>, failed ' + (sp.failed||0) +
               (sp.held_seconds ? ', longest hold ' + sp.held_seconds + 's' : '') +
               (sp.damage_taken ? ', ' + sp.damage_taken + ' damage taken' : ''));
  }
  if (rankedBy[k]){
    var s2 = rankedBy[k];
    notes.push('Scored safe spot: <b>' + s2.score + '</b> (avoids ' + s2.attackers_avoided + ' of ' + (s2.attackers_avoided + (s2.can_reach_you||0)) + ' attacker positions)');
  }
  (D.jumps||[]).forEach(function(j){
    if (j.from.row===r && j.from.col===c) notes.push('<b>Declared fall-jump take-off</b> \\u2192 ' + j.to.row + ',' + j.to.col + '. ' + esc(j.note||''));
    if (j.to.row===r && j.to.col===c) notes.push('<b>Declared fall-jump landing</b> \\u2190 ' + j.from.row + ',' + j.from.col);
  });
  if (notes.length) h += '<div class="note">' + notes.join('<br><br>') + '</div>';
  el.innerHTML = h;
}

/* ---- route picker ---- */
var pick = document.getElementById('routePick');
routeKeys.forEach(function(k){
  var rt = D.routes[k];
  var to = (D.anchors||[]).filter(function(a){ return a.row===rt.to.row && a.col===rt.to.col; })[0];
  var o = document.createElement('option');
  o.value = k;
  o.textContent = k + (to ? '  \\u2192 room ' + to.to : '');
  pick.appendChild(o);
});
if (!routeKeys.length){
  var o2 = document.createElement('option'); o2.textContent = 'no routes baked for this room'; pick.appendChild(o2); pick.disabled = true;
}
pick.value = currentRoute || '';
pick.addEventListener('change', function(){ currentRoute = pick.value; routeMeta(); draw(); });
function routeMeta(){
  var el = document.getElementById('routeMeta');
  if (!currentRoute){ el.textContent = 'This room has no baked routes.'; return; }
  var rt = D.routes[currentRoute];
  el.innerHTML = rt.squares.length + ' squares of ground &middot; ' + rt.pivots.length + ' pivots &middot; ' +
                 '<span style="color:var(--rail)">' + rt.sent.length + ' packets sent</span>' +
                 (rt.unverified ? ' &middot; <span style="color:var(--bad)">unverified pivots</span>' : '');
}

/* ---- header stats ---- */
function statBlock(v, label, cls){
  return '<div class="stat ' + (cls||'') + '"><b>' + v + '</b><span>' + label + '</span></div>';
}
/* A ROW THE WALKER CHOSE NOT TO TRY IS NOT A RAIL THAT FAILED. attempted:false marks a
   deliberate skip - most often "the door is already 0 squares away, a rail across the room
   would be a detour" - and counting those as failures overstates the failure rate.
   Absent means true, so older rows keep their meaning. */
var railRows = D.tacticsRows.filter(function(t){ return t.tactic === 'baked_rail' && t.attempted !== false; });
var railOk = railRows.filter(function(t){ return t.worked; }).length;
var cross = D.crossings.filter(function(x){ return x.room === D.room.num; });
var crossOk = cross.filter(function(x){ return x.ok; });
/* A DEPARTURE IS NOT A CROSSING, AND THE MEDIAN WAS MADE OF DOORSTEPS.
   A character that enters a room beside the exit it wants and steps straight back out
   records a leg exactly like one that walked the whole room. In Ukgoth 38 of 121
   "successful" departures took under five seconds, which is not a traversal of anything —
   and including them put the median at 15s for a room whose real median is nearer two
   minutes.

   THE FLOOR IS AN OPERATOR MEASUREMENT, NOT A GUESS. Thirteen seconds, because no human
   has ever walked an exit-to-exit in Ukgoth faster than that without cheating — with one
   exception, Castle Victoria to the Sentinel, which is a genuinely short pair. A transit
   row records the room and the destination but NOT the door the character came in by, so
   that exception cannot be told apart here and will be excluded along with the doorsteps.
   The page says so rather than quietly folding it in.

   This is a room-shaped constant standing in a general tool: it is right for Ukgoth
   because somebody walked it, and for another room the honest reading is the histogram
   rather than the median. */
var DOORSTEP_MS = 13000;
var doorsteps = crossOk.filter(function(x){ return x.ms < DOORSTEP_MS; }).length;
var times = crossOk.filter(function(x){ return x.ms >= DOORSTEP_MS; })
                   .map(function(x){ return x.ms; }).sort(function(a,b){ return a-b; });
var p50 = times.length ? Math.round(times[times.length >> 1]/1000) : null;
document.getElementById('hRoom').textContent = D.room.num;
document.getElementById('hName').textContent = D.room.name;
document.getElementById('hFile').textContent = D.room.rooFile + ' \\u00b7 ' + ROWS + '\\u00d7' + COLS + ' \\u00b7 ' + D.masks.attached + ' step masks';
document.getElementById('hStats').innerHTML =
  statBlock(apprCount, 'squares with a refused approach') +
  (railRows.length ? statBlock(railOk + '/' + railRows.length, 'rail crossings worked', railOk/railRows.length < .5 ? 'warn' : 'good') : '') +
  (cross.length ? statBlock(crossOk.length + '/' + cross.length, 'left the room', crossOk.length/cross.length < .5 ? 'warn' : 'good') : '') +
  (p50 !== null ? statBlock(p50 + 's', 'median real crossing') : '');

/* ---- findings ---- */
function findings(){
  var out = [];
  var tac = {};
  D.tacticsRows.forEach(function(t){
    tac[t.tactic] = tac[t.tactic] || { ok:0, fail:0, skipped:0 };
    if (t.attempted === false) { tac[t.tactic].skipped++; return; }
    tac[t.tactic][t.worked ? 'ok' : 'fail']++;
  });
  var names = Object.keys(tac).sort(function(a,b){
    return (tac[b].ok+tac[b].fail) - (tac[a].ok+tac[a].fail);
  });
  if (names.length){
    var h = '<table class="mini"><thead><tr><th>Tactic</th><th>Worked</th><th>Failed</th><th>Rate</th></tr></thead><tbody>';
    names.forEach(function(n){
      var t = tac[n], tot = t.ok + t.fail, rate = Math.round(100*t.ok/tot);
      h += '<tr><td>' + esc(n) + '</td><td>' + t.ok + '</td><td>' + t.fail + '</td><td style="color:' +
           (rate < 50 ? 'var(--bad)' : 'var(--ok)') + '">' + rate + '%</td></tr>';
    });
    out.push(h + '</tbody></table>');
  }
  var bk = Object.keys(boarding).sort(function(a,b){ return boarding[b].n - boarding[a].n; });
  if (bk.length){
    var tot = bk.reduce(function(n,k){ return n + boarding[k].n; }, 0);
    var h2 = '<div class="eyebrow" style="margin:16px 0 8px">Where boarding fails</div>';
    bk.slice(0, 6).forEach(function(k){
      var b = boarding[k];
      var why = Object.keys(b.reasons).sort(function(x,y){ return b.reasons[y]-b.reasons[x]; })
                  .map(function(x){ return esc(x) + ' \\u00d7' + b.reasons[x]; }).join(', ');
      h2 += '<div class="finding"><div class="head"><b>' + k + '</b>' +
            '<span class="pill bad">' + b.n + ' of ' + tot + '</span></div>' +
            '<div class="bar"><i style="width:' + Math.round(100*b.n/tot) + '%"></i></div>' +
            '<p>' + why + '</p></div>';
    });
    out.push(h2);
  }
  var sk = Object.keys(slipAt).sort(function(a,b){ return slipAt[b].n - slipAt[a].n; });
  if (sk.length){
    var h3 = '<div class="eyebrow" style="margin:16px 0 8px">Where it slips off</div><table class="mini"><thead><tr><th>Square</th><th>Times</th></tr></thead><tbody>';
    sk.slice(0, 6).forEach(function(k){ h3 += '<tr><td>' + k + '</td><td>' + slipAt[k].n + '</td></tr>'; });
    out.push(h3 + '</tbody></table>');
  }
  var unplaced = (D.tactics.slips||[]).filter(function(s){ return !s.on; }).length;
  if (unplaced) out.push('<p style="font-size:12px;color:var(--muted);margin-top:10px">' + unplaced +
    ' slip' + (unplaced>1?'s':'') + ' counted against a path length no baked route has, so ' +
    (unplaced>1?'they are':'it is') + ' not drawn. A route was rebaked since, or the slip came from a path this view does not hold.</p>');
  if (!out.length) out.push('<p style="font-size:12px;color:var(--muted)">No tactics ledger entries for this room.</p>');
  document.getElementById('findingsBody').innerHTML = out.join('');
}
findings();

/* ---- crossings ---- */
(function(){
  var el = document.getElementById('crossBody');
  if (!cross.length && !D.crossings.length){
    document.getElementById('crossSection').style.display = 'none'; return;
  }
  var inbound = D.crossings.filter(function(x){ return x.to === D.room.num; });
  var dest = {};
  cross.forEach(function(x){ var k = x.to + ' ' + (x.to_name||''); dest[k] = dest[k] || {n:0, ok:0}; dest[k].n++; if (x.ok) dest[k].ok++; });
  var h = '<table class="mini"><thead><tr><th>Left toward</th><th>Tries</th><th>Made it</th></tr></thead><tbody>';
  Object.keys(dest).sort(function(a,b){ return dest[b].n - dest[a].n; }).forEach(function(k){
    h += '<tr><td>' + esc(k) + '</td><td>' + dest[k].n + '</td><td style="color:' +
         (dest[k].ok/dest[k].n < .5 ? 'var(--bad)' : 'var(--ok)') + '">' + dest[k].ok + '</td></tr>';
  });
  h += '</tbody></table>';
  if (doorsteps){
    h += '<p style="font-size:12px;color:var(--muted);margin-top:10px"><b>' + doorsteps + ' of ' +
         crossOk.length + '</b> departures took under ' + (DOORSTEP_MS/1000) + 's — below the fastest ' +
         'exit-to-exit a person has walked here, so a step out of a door the character arrived ' +
         'beside rather than a crossing. Excluded below.</p>';
  }
  if (times.length){
    h += '<p style="font-size:12px;color:var(--muted);margin-top:' + (doorsteps ? '6' : '10') + 'px">Of the ' +
         times.length + ' that actually crossed: fastest <b>' + Math.round(times[0]/1000) +
         's</b>, median <b>' + p50 + 's</b>, slowest <b>' + Math.round(times[times.length-1]/1000) + 's</b>.</p>';
  }
  h += '<p style="font-size:12px;color:var(--muted);margin-top:6px">' + inbound.length + ' arrivals into this room are on record.</p>';
  el.innerHTML = h;
})();

document.getElementById('foot').innerHTML =
  (standDegenerate ? '<b>Every square in this room is BSP-standable</b>, so "standable but not coarse-walkable" here just means rock — which is why the safe-spot layer is the per-approach one. ' : '') +
  'Geometry from <span class="mono">substrate/m59-map.json</span>' +
  (D.builtAt ? ', baked ' + esc(String(D.builtAt).slice(0,10)) : '') +
  '. ' + D.masks.attached + ' rooms carry step masks, so the mover predicate here is the one the broker plans on.' +
  (Object.keys(refusals).length ? '' :
    ' The refusal layer is empty because ' + (D.tracePresent
      ? 'the current collision trace holds no rows for this room — it is cleared on every run'
      : 'the collision trace is off') +
    '. That is NOT MEASURED, never "nothing was refused".') +
  '<br>Generated ' + esc(String(D.generatedAt).slice(0,16).replace('T',' ')) + ' by <span class="mono">tools/m59-roomview.mjs</span>. Read-only: this page joined nobody.';

window.addEventListener('resize', resize);
resize(); fit();
})();
</script>
`;

export function renderPage(data) {
  const title = data.room.name ? `${data.room.name} (${data.room.num})` : `Room ${data.room.num}`;
  return PAGE
    .replace('__TITLE__', title.replace(/[<>&]/g, ''))
    // Split the closing tag so a name in the data can never end the script element early.
    .replace('__DATA__', JSON.stringify(data).replace(/<\//g, '<\\/'));
}

// ---------------------------------------------------------------------------

function usage() {
  console.log(`node tools/m59-roomview.mjs <room number or name> [options]

  --out <file>      where to write (default substrate/roomviews/<num>-<name>.html)
  --fleet <name>    only this fleet's tactics ledger; repeatable, default every one
  --open            open it when it is written
  --json <file>     also write the raw extracted data
  --list            list rooms that have baked routes, and stop

Offline and read-only. It opens no socket, joins nobody and writes only the file you ask for.`);
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { usage(); process.exit(args.length ? 0 : 1); }

  let which = null, out = null, open = false, jsonOut = null, list = false;
  const fleets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') out = args[++i];
    else if (a === '--fleet') fleets.push(args[++i]);
    else if (a === '--json') jsonOut = args[++i];
    else if (a === '--open') open = true;
    else if (a === '--list') list = true;
    else if (a.startsWith('--')) { console.error('unknown option ' + a); usage(); process.exit(2); }
    else if (which === null) which = a;
    else { console.error('unexpected argument ' + a); process.exit(2); }
  }

  const world = readJson(sub('m59-map.json'));
  if (!world?.rooms) { console.error('no world map — run: node tools/setup.mjs routes'); process.exit(1); }

  if (list) {
    const table = readJson(sub('m59-routes.json'), { rooms: {} });
    const rooms = Object.keys(table.rooms || {}).map(Number).sort((a, b) => a - b);
    for (const n of rooms) {
      const r = world.rooms[String(n)];
      console.log(String(n).padStart(5) + '  ' + (r?.name || '?'));
    }
    console.log('\n' + rooms.length + ' rooms with baked routes.');
    return;
  }

  // A room can be asked for by number or by any part of its name, because nobody remembers
  // that Ukgoth is 599 — and a name that matches more than one room is a question, not a
  // pick: choosing the first quietly draws the wrong room, which is the whole failure mode
  // this repository keeps meeting.
  let roomNum = null;
  if (/^\d+$/.test(which)) {
    roomNum = Number(which);
    if (!world.rooms[which]) { console.error('no room ' + which + ' in the map'); process.exit(1); }
  } else {
    const needle = which.toLowerCase();
    const hits = Object.values(world.rooms).filter(r => (r.name || '').toLowerCase().includes(needle));
    if (!hits.length) { console.error('no room matching "' + which + '"'); process.exit(1); }
    if (hits.length > 1) {
      console.error(hits.length + ' rooms match "' + which + '":');
      for (const r of hits.slice(0, 12)) console.error('  ' + r.num + '  ' + r.name);
      process.exit(1);
    }
    roomNum = hits[0].num;
  }

  const data = collectRoom(roomNum, { fleets: fleets.length ? fleets : null });

  if (!out) {
    const dir = sub('roomviews');
    fs.mkdirSync(dir, { recursive: true });
    out = path.join(dir, roomNum + '-' + (slug(data.room.name) || 'room') + '.html');
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderPage(data));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(data, null, 2));

  const rail = data.tacticsRows.filter(t => t.tactic === 'baked_rail' && t.attempted !== false);
  const railOk = rail.filter(t => t.worked).length;
  // The count worth printing is the per-APPROACH one, which is what safeSpots() gates on.
  // The per-square version ("standable but not coarse-walkable") is mostly rock outdoors,
  // and printing it as "the grids disagree" reads as a room full of safe walls.
  let approaches = 0, walkable = 0, stepless = 0;
  for (let r = 1; r <= data.room.rows; r++)
    for (let c = 1; c <= data.room.cols; c++) {
      if (parseInt(data.grids.disagreeRefused[r-1][c-1], 16) > 0) approaches++;
      if (data.grids.walkable[r-1][c-1] === '1') {
        walkable++;
        if (parseInt(data.grids.moverDegree[r-1][c-1], 16) === 0) stepless++;
      }
    }

  console.log(data.room.num + '  ' + data.room.name + '  (' + data.room.rooFile + ', ' +
              data.room.rows + 'x' + data.room.cols + ')');
  console.log('  step masks attached   ' + data.masks.attached +
              (data.masks.attached ? '' : '  <- NO MASKS: this is the coarse grid, not the mover'));
  console.log('  refused approaches    ' + approaches + ' squares have at least one');
  console.log('  walkable squares      ' + walkable +
              (stepless ? ', of which ' + stepless + ' the mover cannot step out of' : ''));
  console.log('  baked routes          ' + Object.keys(data.routes).length +
              ', ' + data.jumps.length + ' declared fall-jump(s)');
  if (rail.length) console.log('  rail crossings        ' + railOk + ' worked / ' + rail.length + ' tried');
  console.log('  tactics rows          ' + data.tacticsRows.length +
              ', crossings ' + data.crossings.length +
              ', safe walls ranked ' + (data.ranked ? data.ranked.length : 0));
  if (!Object.keys(data.refusals).length)
    console.log('  refusal layer         empty — ' +
                (data.tracePresent ? 'trace holds no rows for this room' : 'collision trace off') +
                ' (not measured, not "nothing refused")');
  console.log('\n  ' + out);

  if (open) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const a = process.platform === 'win32' ? ['/c', 'start', '', out] : [out];
    execFile(cmd, a, () => {});
  }
}

// Windows argv[1] is a drive path rather than a URL, and not comparable to import.meta.url
// without pathToFileURL — the same guard m59-supervise.mjs uses, so this file can be
// imported for `collectRoom` without running the CLI.
const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main(process.argv);
